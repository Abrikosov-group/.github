import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PROFILE_IDS,
  SLOTS,
  buildReport,
  inspectProfile,
  markDistinctProfiles,
  runDiagnostic,
} from "./codex-account-diagnostic.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-account-diagnostic-"));
  await chmod(root, 0o700);
  for (const profileId of PROFILE_IDS) {
    const codexHome = join(root, profileId, ".codex");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await chmod(join(root, profileId), 0o700);
    await writeFile(join(codexHome, "auth.json"), '{"opaque":"fixture"}\n', { mode: 0o600 });
  }
  return root;
}

test("validates three private account profiles and maps six slots without a model call", async () => {
  const root = await fixture();
  try {
    const report = await runDiagnostic({
      profileRoot: root,
      expectedOwnerUid: process.getuid(),
      snapshotSha: "a".repeat(40),
      runId: "42",
      runAttempt: "1",
    });
    assert.equal(report.model_called, false);
    assert.equal(report.browser_used, false);
    assert.equal(report.login_called, false);
    assert.equal(report.slots.length, 6);
    assert.ok(report.slots.every(slot => slot.status === "pending_canary"));
    assert.ok(report.slots.every(slot => slot.login_status_ok === "unknown"));
    assert.deepEqual(report.slots.map(slot => slot.slot), SLOTS.map(slot => slot.id));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a missing profile for both slots that use it", async () => {
  const root = await fixture();
  try {
    await rm(join(root, "codex-2"), { recursive: true, force: true });
    const report = await runDiagnostic({ profileRoot: root, expectedOwnerUid: process.getuid() });
    const affected = report.slots.filter(slot => slot.slot.startsWith("codex-2-"));
    assert.equal(affected.length, 2);
    assert.ok(affected.every(slot => slot.status === "unavailable" && slot.reason === "profile_missing"));
    assert.ok(report.slots.filter(slot => slot.slot.startsWith("codex-1-"))
      .every(slot => slot.status === "pending_canary"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an absent profile root as unavailable", async () => {
  const root = join(tmpdir(), `codex-account-diagnostic-missing-${Date.now()}-${process.pid}`);
  const report = await runDiagnostic({ profileRoot: root, expectedOwnerUid: process.getuid() });
  assert.ok(report.slots.every(slot => slot.status === "unavailable"));
  assert.ok(report.slots.every(slot => slot.reason === "profile_root_missing"));
});

test("rejects symlinks and unsafe permissions without reading auth content", async () => {
  const root = await fixture();
  try {
    await rm(join(root, "codex-1"), { recursive: true, force: true });
    await symlink(join(root, "codex-2"), join(root, "codex-1"));
    const symlinkResult = await inspectProfile(root, "codex-1", { expectedOwnerUid: process.getuid() });
    assert.equal(symlinkResult.status, "misconfigured");
    assert.equal(symlinkResult.reason, "profile_not_directory");

    await chmod(join(root, "codex-2", ".codex", "auth.json"), 0o644);
    const permissionResult = await inspectProfile(root, "codex-2", { expectedOwnerUid: process.getuid() });
    assert.equal(permissionResult.status, "misconfigured");
    assert.equal(permissionResult.reason, "auth_permissions");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks duplicate profile identities as unsafe", () => {
  const results = {
    "codex-1": { configured: true, profilePermissionsOk: true, loginStatusOk: "unknown",
      profileIsDistinct: null, switchWithoutInteractiveLogin: "unknown",
      status: "pending_canary", reason: "metadata_only", identity: { dev: 1, ino: 2 } },
    "codex-2": { configured: true, profilePermissionsOk: true, loginStatusOk: "unknown",
      profileIsDistinct: null, switchWithoutInteractiveLogin: "unknown",
      status: "pending_canary", reason: "metadata_only", identity: { dev: 1, ino: 2 } },
    "codex-3": { configured: true, profilePermissionsOk: true, loginStatusOk: "unknown",
      profileIsDistinct: null, switchWithoutInteractiveLogin: "unknown",
      status: "pending_canary", reason: "metadata_only", identity: { dev: 1, ino: 3 } },
  };
  markDistinctProfiles(results);
  assert.equal(results["codex-1"].status, "misconfigured");
  assert.equal(results["codex-2"].reason, "profile_not_distinct");
  assert.equal(results["codex-3"].profileIsDistinct, true);
});

test("report contains no absolute profile paths or credential fields", () => {
  const profileResults = Object.fromEntries(PROFILE_IDS.map(profileId => [profileId, {
    configured: true,
    profilePermissionsOk: true,
    loginStatusOk: "unknown",
    profileIsDistinct: true,
    switchWithoutInteractiveLogin: "unknown",
    status: "pending_canary",
    reason: "metadata_only",
  }]));
  const report = buildReport({ snapshotSha: "b".repeat(40), profileResults });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /auth\.json|token|email|account.?id|\/var\/|\/tmp\//iu);
  assert.doesNotMatch(serialized, /opaque|fixture/iu);
});
