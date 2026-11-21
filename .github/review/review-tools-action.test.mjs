import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const action = resolve(".github/actions/review-tools");
const utilities = resolve(".github/review");
const manifestHash = createHash("sha256").update(readFileSync(join(action, "tools.sha256"))).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "private-review-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const envFile = join(root, "env");
  writeFileSync(envFile, "");
  return {
    root,
    envFile,
    stage(hash, directory = action) {
      return spawnSync("python3", ["-I", join(directory, "stage.py")], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, EXPECTED_MANIFEST_SHA256: hash, RUNNER_TEMP: root, GITHUB_ENV: envFile },
      });
    },
  };
}

test("каждый запуск получает отдельную проверенную копию всех исполняемых утилит", (t) => {
  const { root, envFile, stage } = fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = stage(manifestHash);
    assert.equal(result.status, 0, result.stderr);
  }
  const directories = readFileSync(envFile, "utf8").trimEnd().split("\n").map((line) => {
    assert.ok(line.startsWith("REVIEW_TOOLS_DIR="));
    return line.slice("REVIEW_TOOLS_DIR=".length);
  });
  assert.equal(directories.length, 2);
  assert.notEqual(directories[0], directories[1]);
  const expected = readdirSync(utilities).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs")).sort();
  for (const dir of directories) {
    assert.ok(dir.startsWith(realpathSync(root) + "/"));
    assert.deepEqual(readdirSync(dir).sort(), expected);
    for (const name of expected) assert.deepEqual(readFileSync(join(dir, name)), readFileSync(join(utilities, name)));
  }
});

test("неверная сумма манифеста останавливает действие до предоставления каталога", (t) => {
  const { root, envFile, stage } = fixture(t);
  const result = stage("0".repeat(64));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /контрольная сумма манифеста/u);
  assert.equal(readFileSync(envFile, "utf8"), "");
  assert.deepEqual(readdirSync(root), ["env"]);
});

test("изменённые байты утилиты отклоняются даже при правильной сумме манифеста", (t) => {
  const { root, envFile, stage } = fixture(t);
  const source = join(root, "fixture", ".github");
  const copy = join(source, "actions", "review-tools");
  mkdirSync(copy, { recursive: true });
  cpSync(action, copy, { recursive: true });
  cpSync(utilities, join(source, "review"), { recursive: true });
  writeFileSync(join(source, "review", "prepare-codex-input.mjs"), "// changed fixture");
  const result = stage(manifestHash, copy);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Не совпала контрольная сумма prepare-codex-input.mjs/u);
  assert.equal(readFileSync(envFile, "utf8"), "");
  assert.deepEqual(readdirSync(root).sort(), ["env", "fixture"]);
});
