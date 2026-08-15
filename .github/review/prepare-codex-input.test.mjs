import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { collectDiffAnchors } from "./publish-claude-review.mjs";

const scriptPath = fileURLToPath(new URL("./prepare-codex-input.mjs", import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "review-test@example.invalid",
      GIT_AUTHOR_NAME: "Тест организационного ревью",
      GIT_COMMITTER_EMAIL: "review-test@example.invalid",
      GIT_COMMITTER_NAME: "Тест организационного ревью",
      LC_ALL: "C",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!options.allowFailure && (result.status !== 0 || result.error)) {
    assert.fail(
      `${command} ${args.join(" ")} завершился ошибкой:\n${result.stderr || result.error}`,
    );
  }
  return result;
}

function git(repository, ...args) {
  return run("git", args, { cwd: repository }).stdout.trim();
}

function write(repository, relativePath, content) {
  const absolutePath = join(repository, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function deterministicBinary(size, seed) {
  const result = Buffer.allocUnsafe(size);
  let offset = 0;
  let counter = 0;
  while (offset < size) {
    const block = createHash("sha256").update(seed).update(`:${counter}`).digest();
    block.copy(result, offset, 0, Math.min(block.length, size - offset));
    offset += block.length;
    counter += 1;
  }
  result[0] = 0;
  return result;
}

function prepare(repository, baseSha, mergeBaseSha, headSha, directory) {
  const diffPath = join(directory, "pull-request.diff");
  const manifestPath = join(directory, "binary-manifest.json");
  const result = run(
    process.execPath,
    [
      scriptPath,
      "--base-sha",
      baseSha,
      "--merge-base-sha",
      mergeBaseSha,
      "--head-sha",
      headSha,
      "--diff-path",
      diffPath,
      "--manifest-path",
      manifestPath,
    ],
    { cwd: repository },
  );
  return {
    summary: JSON.parse(result.stdout),
    diff: readFileSync(diffPath),
    manifest: readFileSync(manifestPath),
  };
}

test("бинарный payload заменяется точным детерминированным manifest", (context) => {
  const root = mkdtempSync(join(tmpdir(), "prepare-codex-input-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--quiet", "--initial-branch=main");

  write(repository, "src/main.js", "export const answer = 41;\n");
  write(repository, "assets/rename-old.bin", deterministicBinary(4096, "rename"));
  write(repository, "assets/delete.bin", deterministicBinary(3072, "delete"));
  write(repository, "assets/change.bin", deterministicBinary(2048, "change-before"));
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "Базовый снимок");
  const mergeBaseSha = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "--quiet", "--create", "feature");

  write(repository, "src/main.js", "export const answer = 42;\n");
  const addedBinary = deterministicBinary(335_264, "large-font-fixture");
  write(repository, "assets/шрифт с пробелом.woff2", addedBinary);
  renameSync(
    join(repository, "assets/rename-old.bin"),
    join(repository, "assets/переименован.bin"),
  );
  unlinkSync(join(repository, "assets/delete.bin"));
  write(repository, "assets/change.bin", deterministicBinary(3072, "change-after"));
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "Смешанные изменения");
  const headSha = git(repository, "rev-parse", "HEAD");

  git(repository, "switch", "--quiet", "main");
  write(repository, "base-only.txt", "Целевая ветка продвинулась после создания feature.\n");
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "Продвинуть целевую ветку");
  const baseSha = git(repository, "rev-parse", "HEAD");
  assert.notEqual(baseSha, mergeBaseSha);
  assert.equal(git(repository, "merge-base", baseSha, headSha), mergeBaseSha);

  const oldBinaryDiff = run(
    "git",
    ["diff", "--binary", "--find-renames", "--full-index", mergeBaseSha, headSha, "--"],
    { cwd: repository },
  ).stdout;
  assert.ok(Buffer.byteLength(oldBinaryDiff) > 400_000, "фикстура воспроизводит раздувание diff");
  assert.match(oldBinaryDiff, /GIT binary patch/u);

  const firstDirectory = join(root, "first");
  const secondDirectory = join(root, "second");
  const first = prepare(repository, baseSha, mergeBaseSha, headSha, firstDirectory);
  const second = prepare(repository, baseSha, mergeBaseSha, headSha, secondDirectory);
  const diffText = first.diff.toString("utf8");
  const manifest = JSON.parse(first.manifest.toString("utf8"));

  assert.equal(first.summary.diffBytes, first.diff.length);
  assert.equal(first.summary.manifestBytes, first.manifest.length);
  assert.equal(first.summary.binaryFiles, 4);
  assert.ok(first.diff.length < 20_000, "сырой бинарный payload не попал в текстовый diff");
  assert.doesNotMatch(diffText, /GIT binary patch|^literal [0-9]+$/mu);
  assert.match(diffText, /-export const answer = 41;/u);
  assert.match(diffText, /\+export const answer = 42;/u);
  assert.match(diffText, /Binary files/u);
  const publisherAnchors = collectDiffAnchors(diffText);
  assert.equal(publisherAnchors.get("src/main.js")?.LEFT.has(1), true);
  assert.equal(publisherAnchors.get("src/main.js")?.RIGHT.has(1), true);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.baseSha, baseSha);
  assert.equal(manifest.mergeBaseSha, mergeBaseSha);
  assert.equal(manifest.headSha, headSha);
  assert.equal(manifest.files.length, 4);

  const added = manifest.files.find(
    (file) => file.newPath === "assets/шрифт с пробелом.woff2",
  );
  assert.equal(added.status, "A");
  assert.equal(added.oldBlob, null);
  assert.equal(added.newBlob.bytes, addedBinary.length);
  assert.equal(
    added.newBlob.oid,
    git(repository, "rev-parse", `${headSha}:assets/шрифт с пробелом.woff2`),
  );
  assert.equal(added.newBlob.sha256, createHash("sha256").update(addedBinary).digest("hex"));

  const changed = manifest.files.find((file) => file.newPath === "assets/change.bin");
  assert.equal(changed.status, "M");
  assert.notEqual(changed.oldBlob.sha256, changed.newBlob.sha256);
  assert.equal(changed.oldBlob.bytes, 2048);
  assert.equal(changed.newBlob.bytes, 3072);

  const deleted = manifest.files.find((file) => file.oldPath === "assets/delete.bin");
  assert.equal(deleted.status, "D");
  assert.ok(deleted.oldBlob);
  assert.equal(deleted.newBlob, null);

  const renamed = manifest.files.find((file) => file.status === "R100");
  assert.equal(renamed.oldPath, "assets/rename-old.bin");
  assert.equal(renamed.newPath, "assets/переименован.bin");
  assert.deepEqual(renamed.oldBlob, renamed.newBlob);

  assert.deepEqual(first.diff, second.diff);
  assert.deepEqual(first.manifest, second.manifest);

  const rejected = run(
    process.execPath,
    [
      scriptPath,
      "--base-sha",
      baseSha,
      "--merge-base-sha",
      baseSha,
      "--head-sha",
      headSha,
      "--diff-path",
      join(root, "wrong", "pull-request.diff"),
      "--manifest-path",
      join(root, "wrong", "binary-manifest.json"),
    ],
    { cwd: repository, allowFailure: true },
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /не совпадает с вычисленным/u);
});

test("утилита отклоняет сокращённые SHA до запуска git", () => {
  const result = run(
    process.execPath,
    [
      scriptPath,
      "--base-sha",
      "abc123",
      "--merge-base-sha",
      "abc123",
      "--head-sha",
      "def456",
      "--diff-path",
      "diff",
      "--manifest-path",
      "manifest",
    ],
    { allowFailure: true },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /полными 40-символьными SHA-1/u);
});

test("утилита отклоняет неизвестные аргументы", () => {
  const result = run(process.execPath, [scriptPath, "--неизвестный", "аргумент"], {
    allowFailure: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Неизвестный аргумент/u);
});
