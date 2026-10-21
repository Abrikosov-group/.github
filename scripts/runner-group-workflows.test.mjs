import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./runner-group-workflows.mjs", import.meta.url));
const originalWorkflow = "example-org/.github/.github/workflows/review-all.yml@abc123";
const addedWorkflow = "example-org/sample-project/.github/workflows/review-all.yml@refs/heads/staging";
const firstRepoId = 111111111;
const secondRepoId = 222222222;

const fakeGh = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const method = args[args.indexOf("--method") + 1];
const endpoint = args.at(-1);
const file = process.env.GH_STUB_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const body = args.includes("--input") ? JSON.parse(fs.readFileSync(0, "utf8")) : null;
state.calls.push({ method, endpoint, body });
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const repositories = endpoint.match(/\\/repositories\\?per_page=100&page=(\\d+)$/);
const addRepository = endpoint.match(/\\/repositories\\/(\\d+)$/);
if (method === "GET" && repositories && state.patchApplied && state.failReadsAfterPatch) {
  process.stderr.write("forced repository GET failure");
  process.exitCode = 1;
} else if (method === "GET" && repositories) {
  const page = Number(repositories[1]);
  const ids = state.repositories.slice((page - 1) * 100, page * 100);
  const totalCount = state.repositories.length;
  if (page === 1 && state.removeAfterFirstPage) {
    state.repositories = state.repositories.filter(id => id !== state.removeAfterFirstPage);
  }
  if (page === 1 && state.swapAfterFirstPage) {
    const { removedId, addedId } = state.swapAfterFirstPage;
    state.repositories = state.repositories.filter(id => id !== removedId);
    state.repositories.push(addedId);
    delete state.swapAfterFirstPage;
  }
  process.stdout.write(JSON.stringify({
    total_count: totalCount,
    repositories: ids.map(id => ({ id })),
  }));
} else if (method === "GET" && endpoint.endsWith("/987654321")) {
  const snapshot = JSON.stringify(state.group);
  if (state.addWorkflowAfterFirstGroupRead && !state.groupChanged) {
    state.group.selected_workflows.push(state.addWorkflowAfterFirstGroupRead);
    state.groupChanged = true;
  }
  process.stdout.write(snapshot);
} else if (method === "PATCH" && endpoint.endsWith("/987654321")) {
  state.group = { ...state.group, ...body };
  state.patchApplied = true;
  if (state.resetOnPatch) state.repositories = [];
  save();
  process.stdout.write(JSON.stringify(state.group));
  if (state.failPatchAfterMutation) {
    process.stderr.write("forced PATCH failure after mutation");
    process.exitCode = 1;
  }
} else if (method === "PUT" && addRepository) {
  const id = Number(addRepository[1]);
  if (id === state.failPutId) {
    save();
    process.stderr.write("forced PUT failure");
    process.exitCode = 1;
  } else {
    if (!state.repositories.includes(id)) state.repositories.push(id);
    save();
  }
} else {
  save();
  process.stderr.write("unexpected gh api call");
  process.exitCode = 1;
}
save();
`;

function run(t, state, extraArgs = []) {
  const directory = mkdtempSync(join(tmpdir(), "runner-group-workflows-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "gh"), fakeGh, { mode: 0o755 });
  const stateFile = join(directory, "state.json");
  writeFileSync(stateFile, JSON.stringify({ calls: [], resetOnPatch: true, ...state }));
  const args = [
    script,
    "--org", "example-org",
    "--group-id", "987654321",
    "--add-workflow", addedWorkflow,
    "--require-repo-id", String(firstRepoId),
    "--require-repo-id", String(secondRepoId),
    ...extraArgs,
  ];
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GH_") || key.startsWith("GITHUB_")) delete environment[key];
  }
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: {
      ...environment,
      RUNNER_GROUP_GH_EXECUTABLE: join(directory, "gh"),
      GH_CONFIG_DIR: directory,
      GH_STUB_STATE: stateFile,
    },
  });
  return { result, state: JSON.parse(readFileSync(stateFile, "utf8")) };
}

function group() {
  return {
    name: "codex-spark-review",
    visibility: "selected",
    allows_public_repositories: true,
    restricted_to_workflows: true,
    selected_workflows: [originalWorkflow],
  };
}

test("dry run reads membership without changing the group", t => {
  const { result, state } = run(t, {
    group: group(),
    repositories: [firstRepoId, secondRepoId],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run/);
  assert.deepEqual(state.group.selected_workflows, [originalWorkflow]);
  assert.deepEqual(state.repositories, [firstRepoId, secondRepoId]);
  assert.ok(state.calls.every(call => call.method === "GET"));
});

test("an update that clears access restores every original repository", t => {
  const thirdRepository = 333333333;
  const { result, state } = run(t, {
    group: group(),
    repositories: [firstRepoId, secondRepoId, thirdRepository],
  }, ["--apply"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(new Set(state.repositories), new Set([firstRepoId, secondRepoId, thirdRepository]));
  assert.deepEqual(state.group.selected_workflows, [originalWorkflow, addedWorkflow]);
  const patch = state.calls.find(call => call.method === "PATCH");
  assert.ok(patch);
  assert.equal("visibility" in patch.body, false);
  assert.equal(patch.body.allows_public_repositories, true);
  assert.equal(state.calls.filter(call => call.method === "PUT").length, 3);
});

test("a PATCH error after mutation still restores the original repositories", t => {
  const { result, state } = run(t, {
    group: group(),
    repositories: [firstRepoId, secondRepoId],
    failPatchAfterMutation: true,
  }, ["--apply"]);
  assert.equal(result.status, 1);
  assert.deepEqual(new Set(state.repositories), new Set([firstRepoId, secondRepoId]));
  assert.match(result.stderr, /PATCH.*failed/);
  assert.doesNotMatch(result.stdout, /workflow added/);
});

test("a missing required repository blocks the change before PATCH", t => {
  const { result, state } = run(t, {
    group: group(),
    repositories: [firstRepoId],
  }, ["--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already missing a required repository/);
  assert.ok(state.calls.every(call => call.method === "GET"));
});

test("a repository removed between pagination pages blocks PATCH", t => {
  const removedId = 444444444;
  const repositories = [firstRepoId, secondRepoId, ...Array.from({ length: 98 }, (_, i) => removedId + i)];
  const { result, state } = run(t, {
    group: group(),
    repositories,
    removeAfterFirstPage: removedId,
  }, ["--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /changed while reading pages/);
  assert.ok(state.calls.every(call => call.method === "GET"));
});

test("a same-count repository swap between pages blocks PATCH", t => {
  const removedId = 444444444;
  const addedId = 555555555;
  const repositories = [firstRepoId, secondRepoId, ...Array.from({ length: 99 }, (_, i) => removedId + i)];
  const { result, state } = run(t, {
    group: group(),
    repositories,
    swapAfterFirstPage: { removedId, addedId },
  }, ["--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /changed between complete reads/);
  assert.ok(state.calls.every(call => call.method === "GET"));
});

test("a concurrent workflow update before PATCH blocks the change", t => {
  const externalWorkflow = "example-org/other-project/.github/workflows/check.yml@refs/heads/main";
  const { result, state } = run(t, {
    group: group(),
    repositories: [firstRepoId, secondRepoId],
    addWorkflowAfterFirstGroupRead: externalWorkflow,
  }, ["--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /changed during preflight/);
  assert.deepEqual(state.group.selected_workflows, [originalWorkflow, externalWorkflow]);
  assert.ok(state.calls.every(call => call.method === "GET"));
});

test("failed restoration exits with an error instead of claiming success", t => {
  const { result, state } = run(t, {
    group: group(),
    repositories: [firstRepoId, secondRepoId],
    failPutId: secondRepoId,
  }, ["--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not be restored/);
  assert.equal(state.repositories.includes(secondRepoId), false);
  assert.doesNotMatch(result.stdout, /workflow added/);
});

test("an uncertain PATCH keeps the original IDs and all recovery errors visible", t => {
  const { result, state } = run(t, {
    group: group(),
    repositories: [firstRepoId, secondRepoId],
    failPatchAfterMutation: true,
    failReadsAfterPatch: true,
    failPutId: secondRepoId,
  }, ["--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /original repository IDs: 111111111, 222222222/);
  assert.match(result.stderr, /original repository IDs: 111111111, 222222222/);
  assert.match(result.stderr, /PATCH:.*forced PATCH failure/);
  assert.match(result.stderr, /failed PUTs:.*222222222:.*forced PUT failure/);
  assert.match(result.stderr, /verification:.*forced repository GET failure/);
  assert.equal(state.repositories.includes(secondRepoId), false);
});
