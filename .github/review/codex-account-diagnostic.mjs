import { lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

export const DIAGNOSTIC_PROTOCOL_VERSION = "1";
export const PROFILE_IDS = ["codex-1", "codex-2", "codex-3"];
export const SLOTS = [
  { id: "codex-1-spark", profileId: "codex-1", model: "gpt-5.3-codex-spark" },
  { id: "codex-2-spark", profileId: "codex-2", model: "gpt-5.3-codex-spark" },
  { id: "codex-3-spark", profileId: "codex-3", model: "gpt-5.3-codex-spark" },
  { id: "codex-1-sol", profileId: "codex-1", model: "gpt-5.6-sol" },
  { id: "codex-2-sol", profileId: "codex-2", model: "gpt-5.6-sol" },
  { id: "codex-3-sol", profileId: "codex-3", model: "gpt-5.6-sol" },
];

const MAX_AUTH_BYTES = 1024 * 1024;
const PRIVATE_MODE_BITS = 0o077;

function modeIsPrivate(mode, expectedMode) {
  return (mode & PRIVATE_MODE_BITS) === 0 && (mode & 0o777) === expectedMode;
}

async function inspectPath(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function ownerMatches(info, expectedOwnerUid) {
  return expectedOwnerUid === null || info.uid === expectedOwnerUid;
}

function safeFailure(status, reason, profileIsDistinct = null) {
  return {
    configured: false,
    profilePermissionsOk: false,
    loginStatusOk: "unknown",
    profileIsDistinct,
    switchWithoutInteractiveLogin: "unknown",
    status,
    reason,
  };
}

export async function inspectProfile(root, profileId, {
  expectedOwnerUid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (!PROFILE_IDS.includes(profileId)) {
    throw new Error("Неизвестный профиль аккаунта.");
  }

  const profilePath = join(resolve(root), profileId);
  const codexPath = join(profilePath, ".codex");
  const authPath = join(codexPath, "auth.json");
  const profile = await inspectPath(profilePath);
  if (!profile) return safeFailure("unavailable", "profile_missing");
  if (profile.isSymbolicLink() || !profile.isDirectory()) {
    return safeFailure("misconfigured", "profile_not_directory");
  }
  if (!ownerMatches(profile, expectedOwnerUid) || !modeIsPrivate(profile.mode, 0o700)) {
    return safeFailure("misconfigured", "profile_permissions");
  }

  const codex = await inspectPath(codexPath);
  if (!codex) return safeFailure("unavailable", "codex_home_missing");
  if (codex.isSymbolicLink() || !codex.isDirectory()) {
    return safeFailure("misconfigured", "codex_home_not_directory");
  }
  if (!ownerMatches(codex, expectedOwnerUid) || !modeIsPrivate(codex.mode, 0o700)) {
    return safeFailure("misconfigured", "codex_home_permissions");
  }

  const auth = await inspectPath(authPath);
  if (!auth) return safeFailure("unavailable", "auth_missing");
  if (auth.isSymbolicLink() || !auth.isFile()) {
    return safeFailure("misconfigured", "auth_not_regular_file");
  }
  if (!ownerMatches(auth, expectedOwnerUid) || !modeIsPrivate(auth.mode, 0o600)) {
    return safeFailure("misconfigured", "auth_permissions");
  }
  if (auth.size === 0 || auth.size > MAX_AUTH_BYTES) {
    return safeFailure("misconfigured", "auth_size");
  }

  return {
    configured: true,
    profilePermissionsOk: true,
    loginStatusOk: "unknown",
    profileIsDistinct: null,
    switchWithoutInteractiveLogin: "unknown",
    status: "pending_canary",
    reason: "metadata_only",
    identity: { dev: auth.dev, ino: auth.ino },
  };
}

export function markDistinctProfiles(results) {
  const seen = new Map();
  for (const [profileId, result] of Object.entries(results)) {
    if (!result.identity) {
      result.profileIsDistinct = null;
      continue;
    }
    const key = `${result.identity.dev}:${result.identity.ino}`;
    const previous = seen.get(key);
    if (previous) {
      result.profileIsDistinct = false;
      results[previous].profileIsDistinct = false;
      for (const duplicate of [previous, profileId]) {
        results[duplicate].status = "misconfigured";
        results[duplicate].reason = "profile_not_distinct";
      }
    } else {
      seen.set(key, profileId);
      result.profileIsDistinct = true;
    }
  }
  return results;
}

export function buildReport({
  snapshotSha = "manual",
  runId = "manual",
  runAttempt = "1",
  profileResults,
}) {
  const slots = SLOTS.map(slot => {
    const profile = profileResults[slot.profileId];
    return {
      slot: slot.id,
      model: slot.model,
      configured: profile.configured,
      profile_permissions_ok: profile.profilePermissionsOk,
      login_status_ok: profile.loginStatusOk,
      profile_is_distinct: profile.profileIsDistinct,
      switch_without_interactive_login: profile.switchWithoutInteractiveLogin,
      status: profile.status,
      reason: profile.reason,
    };
  });
  const hasUnsafeResult = slots.some(slot => slot.reason === "unsafe_error");
  return {
    protocol_version: DIAGNOSTIC_PROTOCOL_VERSION,
    snapshot_sha: snapshotSha,
    run_id: String(runId),
    run_attempt: String(runAttempt),
    model_called: false,
    browser_used: false,
    login_called: false,
    slots,
    summary: {
      metadata_only: true,
      canary_required: slots.some(slot => slot.status === "pending_canary"),
      safe: !hasUnsafeResult,
    },
  };
}

export async function runDiagnostic({
  profileRoot,
  expectedOwnerUid = typeof process.getuid === "function" ? process.getuid() : null,
  snapshotSha,
  runId,
  runAttempt,
}) {
  const root = resolve(profileRoot);
  const rootInfo = await inspectPath(root);
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()
    || !ownerMatches(rootInfo, expectedOwnerUid) || !modeIsPrivate(rootInfo.mode, 0o700)) {
    const profileResults = Object.fromEntries(PROFILE_IDS.map(id => [
      id, safeFailure("misconfigured", rootInfo ? "profile_root_permissions" : "profile_root_missing"),
    ]));
    return buildReport({ snapshotSha, runId, runAttempt, profileResults });
  }

  const profileResults = {};
  for (const profileId of PROFILE_IDS) {
    profileResults[profileId] = await inspectProfile(root, profileId, { expectedOwnerUid });
  }
  markDistinctProfiles(profileResults);
  return buildReport({ snapshotSha, runId, runAttempt, profileResults });
}

export async function writeReport(report, reportPath) {
  await mkdir(resolve(reportPath, ".."), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function argumentValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const profileRoot = argumentValue(process.argv.slice(2), "--profile-root")
    ?? process.env.CODEX_ACCOUNT_PROFILE_ROOT
    ?? "/var/lib/sawabook-review-codex/profiles";
  const reportPath = argumentValue(process.argv.slice(2), "--report-path");
  if (!reportPath) {
    console.error("Не указан --report-path.");
    process.exitCode = 2;
  } else {
    const ownerUidText = process.env.CODEX_PROFILE_OWNER_UID;
    const expectedOwnerUid = ownerUidText && /^\d+$/u.test(ownerUidText)
      ? Number(ownerUidText)
      : typeof process.getuid === "function" ? process.getuid() : null;
    const report = await runDiagnostic({
      profileRoot,
      expectedOwnerUid,
      snapshotSha: process.env.GITHUB_SHA ?? "manual",
      runId: process.env.GITHUB_RUN_ID ?? "manual",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
    });
    await writeReport(report, reportPath);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.slots.every(slot => slot.status === "pending_canary" || slot.status === "ready")
      ? 0
      : 1;
  }
}
