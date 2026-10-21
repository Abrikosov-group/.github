#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const usage = `Usage:
  node scripts/runner-group-workflows.mjs \
    --org ORG --group-id ID --add-workflow ORG/REPO/.github/workflows/FILE@REF \
    --require-repo-id ID [--require-repo-id ID ...] [--apply]

Without --apply, only reads and prints the planned change. Run this from an
authenticated gh CLI session with organization runner-group administration access.`;

function parseArguments(args) {
  const options = { requiredRepoIds: [], apply: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (flag === "--apply") {
      options.apply = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    switch (flag) {
      case "--org": options.org = value; break;
      case "--group-id": options.groupId = value; break;
      case "--add-workflow": options.workflow = value; break;
      case "--require-repo-id": options.requiredRepoIds.push(value); break;
      default: throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!/^[A-Za-z0-9-]+$/.test(options.org ?? "")) {
    throw new Error("--org must be a GitHub organization name");
  }
  if (!/^[1-9][0-9]*$/.test(options.groupId ?? "")) {
    throw new Error("--group-id must be a positive integer");
  }
  if (
    !options.workflow?.startsWith(`${options.org}/`) ||
    !/^\S+\/\.github\/workflows\/\S+@\S+$/.test(options.workflow)
  ) {
    throw new Error("--add-workflow must be a full workflow path in the organization with @REF");
  }
  if (
    options.requiredRepoIds.length === 0 ||
    options.requiredRepoIds.some(id => !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))
  ) {
    throw new Error("Specify at least one valid --require-repo-id");
  }
  options.requiredRepoIds = [...new Set(options.requiredRepoIds.map(Number))];
  return options;
}

function api(method, endpoint, body) {
  const args = ["api", "--method", method];
  if (body !== undefined) args.push("--input", "-");
  args.push(endpoint);
  const ghExecutable = process.env.RUNNER_GROUP_GH_EXECUTABLE;
  if (ghExecutable && !isAbsolute(ghExecutable)) {
    throw new Error("RUNNER_GROUP_GH_EXECUTABLE must be an absolute path");
  }
  const result = spawnSync(ghExecutable || "gh", args, {
    encoding: "utf8",
    input: body === undefined ? undefined : JSON.stringify(body),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim().slice(0, 300);
    throw new Error(`gh api ${method} ${endpoint} failed: ${detail || `exit ${result.status}`}`);
  }
  if (!result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`gh api ${method} ${endpoint} returned invalid JSON`);
  }
}

function readRepositoriesOnce(groupPath) {
  const ids = [];
  let totalCount;
  for (let page = 1; page <= 1000; page += 1) {
    const result = api("GET", `${groupPath}/repositories?per_page=100&page=${page}`);
    if (!Array.isArray(result?.repositories) || !Number.isInteger(result.total_count)) {
      throw new Error("Could not read the complete selected-repositories list");
    }
    totalCount ??= result.total_count;
    if (result.total_count !== totalCount) {
      throw new Error("Selected-repositories list changed while reading pages");
    }
    for (const repository of result.repositories) {
      if (!Number.isSafeInteger(repository.id) || repository.id <= 0) {
        throw new Error("Repository response contains an invalid ID");
      }
      ids.push(repository.id);
    }
    if (result.repositories.length < 100) {
      if (ids.length !== totalCount || new Set(ids).size !== ids.length) {
        throw new Error("Selected-repositories list changed or was truncated while reading");
      }
      return ids;
    }
  }
  throw new Error("Selected-repositories list exceeded 1000 pages");
}

function sameIds(left, right) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every(id => rightIds.has(id));
}

function readRepositories(groupPath) {
  const first = readRepositoriesOnce(groupPath);
  const second = readRepositoriesOnce(groupPath);
  if (!sameIds(first, second)) {
    throw new Error("Selected-repositories list changed between complete reads");
  }
  return second;
}

function assertGroup(group) {
  if (
    !group || typeof group.name !== "string" ||
    group.visibility !== "selected" ||
    typeof group.allows_public_repositories !== "boolean" ||
    group.restricted_to_workflows !== true ||
    !Array.isArray(group.selected_workflows)
  ) {
    throw new Error("Expected a selected-visibility group restricted to workflows");
  }
  if (group.inherited || group.workflow_restrictions_read_only) {
    throw new Error("The group's workflow restrictions are read-only here");
  }
}

function groupSettings(group) {
  return JSON.stringify({
    name: group.name,
    visibility: group.visibility,
    allows_public_repositories: group.allows_public_repositories,
    restricted_to_workflows: group.restricted_to_workflows,
    selected_workflows: [...group.selected_workflows].sort(),
  });
}

function repairRepositories(groupPath, originalIds) {
  let currentIds;
  try {
    currentIds = readRepositories(groupPath);
  } catch {
    // A PATCH may have applied even if its response or the first read failed.
    // Add every original ID in that case; the single-repository PUT is additive.
    currentIds = [];
  }
  const current = new Set(currentIds);
  const missing = originalIds.filter(id => !current.has(id));
  const failures = [];
  for (const id of missing) {
    try {
      api("PUT", `${groupPath}/repositories/${id}`);
    } catch (error) {
      failures.push(`${id}: ${error.message}`);
    }
  }
  let verified;
  try {
    verified = new Set(readRepositories(groupPath));
  } catch (error) {
    throw new Error(
      `Repository access could not be verified; original IDs: ${originalIds.join(", ")}; ` +
      `failed PUTs: ${failures.join("; ") || "none"}; verification: ${error.message}`,
    );
  }
  const stillMissing = originalIds.filter(id => !verified.has(id));
  if (failures.length || stillMissing.length) {
    throw new Error(
      `Repository access could not be restored; original IDs: ${originalIds.join(", ")}; ` +
      `missing: ${stillMissing.join(", ") || "none"}; ` +
      `failed PUTs: ${failures.join("; ") || "none"}`,
    );
  }
  return missing.length;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const groupPath = `orgs/${options.org}/actions/runner-groups/${options.groupId}`;
  const beforeGroup = api("GET", groupPath);
  assertGroup(beforeGroup);
  const beforeIds = readRepositories(groupPath);
  const beforeSet = new Set(beforeIds);
  if (beforeIds.length === 0 || options.requiredRepoIds.some(id => !beforeSet.has(id))) {
    throw new Error("The group is already missing a required repository; no change was made");
  }
  if (beforeGroup.selected_workflows.includes(options.workflow)) {
    console.log(`Group ${options.groupId}: workflow already allowed; repository access verified.`);
    return;
  }
  const workflows = [...beforeGroup.selected_workflows, options.workflow];
  if (!options.apply) {
    console.log(
      `Dry run: group ${options.groupId}, ${beforeIds.length} repositories preserved, ` +
      `IDs: ${beforeIds.join(", ")}; add ${options.workflow}. Pass --apply to change GitHub.`,
    );
    return;
  }
  const latestIds = readRepositories(groupPath);
  const latestGroup = api("GET", groupPath);
  assertGroup(latestGroup);
  if (!sameIds(beforeIds, latestIds) || groupSettings(beforeGroup) !== groupSettings(latestGroup)) {
    throw new Error("Group settings or repository access changed during preflight; no change was made");
  }
  console.log(`Before PATCH group ${options.groupId}, original repository IDs: ${beforeIds.join(", ")}`);

  let patchError;
  try {
    // GitHub requires `name` in this PATCH; `visibility` is optional:
    // https://docs.github.com/en/rest/actions/self-hosted-runner-groups#update-a-self-hosted-runner-group-for-an-organization
    // Repeating visibility=selected cleared repository access on 19 Oct 2026.
    // Omit it, then verify and restore membership immediately.
    api("PATCH", groupPath, {
      name: beforeGroup.name,
      allows_public_repositories: beforeGroup.allows_public_repositories,
      restricted_to_workflows: true,
      selected_workflows: workflows,
    });
  } catch (error) {
    patchError = error;
  }
  let restoredCount;
  let recoveryError;
  try {
    restoredCount = repairRepositories(groupPath, beforeIds);
  } catch (error) {
    recoveryError = error;
  }
  if (patchError || recoveryError) {
    throw new Error(
      `Group update not verified; original repository IDs: ${beforeIds.join(", ")}; ` +
      `PATCH: ${patchError?.message ?? "completed"}; ` +
      `recovery: ${recoveryError?.message ?? "verified"}`,
    );
  }

  const afterGroup = api("GET", groupPath);
  assertGroup(afterGroup);
  if (afterGroup.allows_public_repositories !== beforeGroup.allows_public_repositories) {
    throw new Error("Public-repository access changed unexpectedly");
  }
  const afterWorkflows = new Set(afterGroup.selected_workflows);
  if (workflows.some(workflow => !afterWorkflows.has(workflow))) {
    throw new Error("Workflow allowlist is missing an original or requested workflow");
  }
  console.log(
    `Group ${options.groupId}: workflow added, all ${beforeIds.length} ` +
    `original repositories verified; restored ${restoredCount}.`,
  );
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
