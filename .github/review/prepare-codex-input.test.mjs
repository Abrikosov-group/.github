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

function deterministicWoff2(size, seed) {
  const result = deterministicBinary(size, seed);
  Buffer.from("wOF2", "ascii").copy(result, 0);
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

  write(repository, "src/layout.tsx", "export const answer = 41;\n");
  write(repository, "assets/rename-old.bin", deterministicBinary(4096, "rename"));
  write(repository, "assets/delete.bin", deterministicBinary(3072, "delete"));
  write(repository, "assets/change.bin", deterministicBinary(2048, "change-before"));
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "Базовый снимок");
  const mergeBaseSha = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "--quiet", "--create", "feature");

  write(repository, "src/layout.tsx", "export const answer = 42;\n");
  const fonts = [
    { path: "assets/fonts/manrope/Manrope.woff2", bytes: deterministicWoff2(110_000, "manrope") },
    { path: "assets/fonts/oswald/Oswald.woff2", bytes: deterministicWoff2(115_000, "oswald") },
    { path: "assets/fonts/cormorant/Cormorant.woff2", bytes: deterministicWoff2(120_264, "cormorant") },
  ];
  for (const font of fonts) {
    write(repository, font.path, font.bytes);
    write(repository, `${dirname(font.path)}/OFL.txt`, "SIL Open Font License 1.1\n");
  }
  write(
    repository,
    "assets/fonts/README.md",
    [
      "# Источник локальных шрифтов",
      "",
      "Репозиторий: `example/fonts`.",
      ...fonts.map((font) => `- ${font.path}: ${createHash("sha256").update(font.bytes).digest("hex")}`),
      "",
    ].join("\n"),
  );
  write(repository, "assets/текст-с-необычным-расширением.avif", "это безопасный текст\n");
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
  assert.equal(first.summary.binaryFiles, 6);
  assert.ok(first.diff.length < 20_000, "сырой бинарный payload не попал в текстовый diff");
  assert.doesNotMatch(diffText, /GIT binary patch|^literal [0-9]+$/mu);
  assert.match(diffText, /-export const answer = 41;/u);
  assert.match(diffText, /\+export const answer = 42;/u);
  assert.match(diffText, /Binary or non-representable content omitted/u);
  const publisherAnchors = collectDiffAnchors(diffText);
  assert.equal(publisherAnchors.get("src/layout.tsx")?.LEFT.has(1), true);
  assert.equal(publisherAnchors.get("src/layout.tsx")?.RIGHT.has(1), true);

  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.baseSha, baseSha);
  assert.equal(manifest.mergeBaseSha, mergeBaseSha);
  assert.equal(manifest.headSha, headSha);
  assert.equal(manifest.files.length, 6);
  assert.match(manifest.binaryManifestSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    manifest.binaryManifestSha256,
    createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex"),
  );

  for (const font of fonts) {
    const added = manifest.files.find((file) => file.newPath === font.path);
    assert.equal(added.status, "A");
    assert.equal(added.oldBlob, null);
    assert.equal(added.newBlob.bytes, font.bytes.length);
    assert.equal(added.newBlob.format, "font/woff2");
    assert.equal(added.newBlob.source.path, "assets/fonts/README.md");
    assert.equal(added.newBlob.license.path, `${dirname(font.path)}/OFL.txt`);
    assert.equal(added.newBlob.oid, git(repository, "rev-parse", `${headSha}:${font.path}`));
    assert.equal(added.newBlob.sha256, createHash("sha256").update(font.bytes).digest("hex"));
    assert.equal(first.diff.includes(font.bytes.subarray(0, 64)), false);
  }
  assert.match(diffText, /\+это безопасный текст/u);
  assert.match(diffText, /\+# Источник локальных шрифтов/u);
  assert.match(diffText, /\+SIL Open Font License 1\.1/u);
  assert.equal(
    manifest.files.some((file) => file.newPath === "assets/текст-с-необычным-расширением.avif"),
    false,
  );

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

  git(repository, "switch", "--quiet", "feature");
  const changedFont = Buffer.from(fonts[0].bytes);
  changedFont[changedFont.length - 1] ^= 0xff;
  write(repository, fonts[0].path, changedFont);
  write(
    repository,
    "assets/fonts/README.md",
    readFileSync(join(repository, "assets/fonts/README.md"), "utf8").replace(
      createHash("sha256").update(fonts[0].bytes).digest("hex"),
      createHash("sha256").update(changedFont).digest("hex"),
    ),
  );
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "Изменить один байт шрифта");
  const changedHeadSha = git(repository, "rev-parse", "HEAD");
  const changedPrepared = prepare(repository, baseSha, mergeBaseSha, changedHeadSha, join(root, "changed"));
  assert.notEqual(
    JSON.parse(changedPrepared.manifest).binaryManifestSha256,
    manifest.binaryManifestSha256,
  );

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

test("gitlink не читается как blob и не попадает в binary manifest", (context) => {
  const root = mkdtempSync(join(tmpdir(), "prepare-codex-gitlink-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const dependency = join(root, "dependency");
  mkdirSync(dependency);
  git(dependency, "init", "--quiet", "--initial-branch=main");
  write(dependency, "dependency.txt", "first\n");
  git(dependency, "add", "--all");
  git(dependency, "commit", "--quiet", "-m", "Первый внешний commit");
  const firstTarget = git(dependency, "rev-parse", "HEAD");
  write(dependency, "dependency.txt", "second\n");
  git(dependency, "add", "--all");
  git(dependency, "commit", "--quiet", "-m", "Второй внешний commit");
  const secondTarget = git(dependency, "rev-parse", "HEAD");

  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--quiet", "--initial-branch=main");
  write(repository, "README.md", "base\n");
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "Первый commit");

  git(repository, "update-index", "--add", "--cacheinfo", `160000,${firstTarget},vendor/dependency`);
  git(repository, "commit", "--quiet", "-m", "Добавить gitlink");
  const mergeBaseSha = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "--quiet", "--create", "feature");
  git(repository, "update-index", "--cacheinfo", `160000,${secondTarget},vendor/dependency`);
  git(repository, "commit", "--quiet", "-m", "Обновить gitlink");
  const headSha = git(repository, "rev-parse", "HEAD");

  assert.equal(run("git", ["cat-file", "-e", firstTarget], {
    cwd: repository,
    allowFailure: true,
  }).status, 1);
  assert.equal(run("git", ["cat-file", "-e", secondTarget], {
    cwd: repository,
    allowFailure: true,
  }).status, 1);

  const prepared = prepare(repository, mergeBaseSha, mergeBaseSha, headSha, join(root, "out"));
  const manifest = JSON.parse(prepared.manifest);
  assert.equal(manifest.files.length, 0);
  assert.match(prepared.diff.toString("utf8"), /Subproject commit/u);
});

test("NUL после первых 8 KiB всё равно исключает payload", (context) => {
  const root = mkdtempSync(join(tmpdir(), "prepare-codex-late-nul-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--quiet", "--initial-branch=main");
  const textPrefix = "text-line: value;\n".repeat(600);
  write(repository, "payload.dat", textPrefix);
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "Текстовая база");
  const mergeBaseSha = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "--quiet", "--create", "feature");
  const payload = Buffer.concat([
    Buffer.from(textPrefix),
    Buffer.from([0]),
    Buffer.from("secret-binary-tail\n"),
  ]);
  write(repository, "payload.dat", payload);
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "Поздний NUL");
  const headSha = git(repository, "rev-parse", "HEAD");

  const prepared = prepare(repository, mergeBaseSha, mergeBaseSha, headSha, join(root, "out"));
  const diff = prepared.diff.toString("utf8");
  const manifest = JSON.parse(prepared.manifest);
  assert.equal(manifest.files.length, 1);
  assert.equal(prepared.diff.includes(0), false);
  assert.doesNotMatch(diff, /secret-binary-tail/u);
  assert.match(diff, /^-text-line: value;$/mu);
  assert.match(diff, /Binary counterpart omitted/u);
});

test("binary-to-text сохраняет только новую текстовую сторону", (context) => {
  const root = mkdtempSync(join(tmpdir(), "prepare-codex-transition-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--quiet", "--initial-branch=main");
  write(repository, "transition.dat", Buffer.from([0, 1, 2, 3]));
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "Бинарная база");
  const mergeBaseSha = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "--quiet", "--create", "feature");
  write(repository, "transition.dat", "первая строка\nвторая строка\n");
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "Текстовая версия");
  const headSha = git(repository, "rev-parse", "HEAD");

  const prepared = prepare(repository, mergeBaseSha, mergeBaseSha, headSha, join(root, "out"));
  const diff = prepared.diff.toString("utf8");
  assert.match(diff, /\+первая строка/u);
  assert.match(diff, /\+вторая строка/u);
  assert.equal(prepared.diff.includes(0), false);
  assert.equal(JSON.parse(prepared.manifest).files.length, 1);
});

test("не-UTF-8 путь кодируется lossless, а безопасный текст сохраняется", (context) => {
  const root = mkdtempSync(join(tmpdir(), "prepare-codex-path-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--quiet", "--initial-branch=main");
  write(repository, "README.md", "base\n");
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "База");
  const mergeBaseSha = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "--quiet", "--create", "feature");
  const relativePath = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74]);
  const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: repository,
    input: Buffer.from("lossless-path-content\n"),
    encoding: "utf8",
  });
  assert.equal(blob.status, 0, blob.stderr);
  const indexEntry = Buffer.concat([
    Buffer.from(`100644 blob ${blob.stdout.trim()}\t`),
    relativePath,
    Buffer.from([0]),
  ]);
  const update = spawnSync("git", ["update-index", "-z", "--index-info"], {
    cwd: repository,
    input: indexEntry,
    encoding: null,
  });
  assert.equal(update.status, 0, update.stderr.toString("utf8"));
  git(repository, "commit", "--quiet", "-m", "Путь Git в байтах");
  const headSha = git(repository, "rev-parse", "HEAD");

  const prepared = prepare(repository, mergeBaseSha, mergeBaseSha, headSha, join(root, "out"));
  const diff = prepared.diff.toString("utf8");
  assert.equal(JSON.parse(prepared.manifest).files.length, 0);
  assert.match(diff, new RegExp(`git-bytes:${relativePath.toString("hex")}`, "u"));
  assert.match(diff, /\+lossless-path-content/u);
  assert.doesNotMatch(diff, /[\u007f-\u009f]/u);
});

test("base64, base85 и ASCII-содержимое binary-типа не попадают во вход", (context) => {
  const root = mkdtempSync(join(tmpdir(), "prepare-codex-encoded-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--quiet", "--initial-branch=main");
  write(repository, "encoded.txt", "до кодирования\n");
  write(repository, ".gitattributes", "forced.txt -diff\n");
  write(repository, "forced.txt", "старый безопасный текст\n");
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "База");
  const mergeBaseSha = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "--quiet", "--create", "feature");
  const base64Payload = Buffer.alloc(4_096, "binary payload").toString("base64");
  write(
    repository,
    "encoded.txt",
    `${"ordinary text before payload\n".repeat(300)}data:application/octet-stream;base64,` +
      `${base64Payload.match(/.{1,76}/gu).join("\n")}\nordinary text after payload\n`,
  );
  write(repository, "encoded85.txt", `<~${"!!!!!".repeat(300)}~>\n`);
  write(repository, "encoded.z85", `${"^!/*?&[]{}@%$#".repeat(100)}\n`);
  write(repository, "source-ascii85-like.js", `${"consta=true;".repeat(100)}\n`);
  write(repository, "source-z85-like.js", `${"consta=true:".repeat(100)}\n`);
  write(repository, "forced.txt", "новый безопасный текст\n");
  write(repository, "manual.pdf", "%PDF-1.7\nASCII-only fixture that must remain opaque.\n");
  write(repository, "danger<marker>.pdf", "%PDF-1.7\nuntrusted path fixture\n");
  write(repository, "danger\u200bmarker.pdf", "%PDF-1.7\nhidden unicode path fixture\n");
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "-m", "Кодированный payload");
  const headSha = git(repository, "rev-parse", "HEAD");

  const prepared = prepare(repository, mergeBaseSha, mergeBaseSha, headSha, join(root, "out"));
  const diff = prepared.diff.toString("utf8");
  const manifest = JSON.parse(prepared.manifest);
  assert.equal(manifest.files.length, 6);
  assert.equal(manifest.files.find((file) => file.newPath === "encoded.txt").reason, "base64-content");
  assert.equal(manifest.files.find((file) => file.newPath === "encoded85.txt").reason, "base85-content");
  assert.equal(manifest.files.find((file) => file.newPath === "encoded.z85").reason, "base85-content");
  assert.equal(manifest.files.some((file) => file.newPath === "source-ascii85-like.js"), false);
  assert.equal(manifest.files.some((file) => file.newPath === "source-z85-like.js"), false);
  assert.equal(manifest.files.find((file) => file.newPath === "manual.pdf").newBlob.format, "application/pdf");
  const encodedPaths = manifest.files.filter((file) => file.newPath?.startsWith("git-bytes:"));
  assert.equal(encodedPaths.length, 2);
  assert.ok(encodedPaths.every((file) => file.newPathEncoding === "hex"));
  assert.doesNotMatch(JSON.stringify(manifest), /\p{Cf}/u);
  assert.doesNotMatch(diff, new RegExp(base64Payload.slice(0, 100), "u"));
  assert.doesNotMatch(diff, /!!!!!/u);
  assert.doesNotMatch(diff, /\^!\/\*\?/u);
  assert.match(diff, /consta=true;/u);
  assert.match(diff, /consta=true:/u);
  assert.match(diff, /-старый безопасный текст/u);
  assert.match(diff, /\+новый безопасный текст/u);
  assert.doesNotMatch(diff, /ASCII-only fixture/u);
  assert.doesNotMatch(diff, /danger<marker>/u);
  assert.doesNotMatch(diff, /danger\u200bmarker/u);
  assert.match(diff, /-до кодирования/u);
});
