import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ZERO_SHA_PATTERN = /^0{40}$/u;
const RAW_HEADER_PATTERN = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z][0-9]*)$/u;
const MAX_GIT_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_GIT_ERROR_BYTES = 64 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function usageError(message) {
  throw new Error(
    `${message}\nИспользование: node prepare-codex-input.mjs ` +
      "--base-sha <sha> --merge-base-sha <sha> --head-sha <sha> " +
      "--diff-path <path> --manifest-path <path>",
  );
}

export function parseArguments(argv) {
  const allowed = new Set([
    "--base-sha",
    "--merge-base-sha",
    "--head-sha",
    "--diff-path",
    "--manifest-path",
  ]);
  const values = new Map();

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name)) {
      usageError(`Неизвестный аргумент: ${name ?? "<пусто>"}.`);
    }
    if (value === undefined || value.length === 0) {
      usageError(`Для ${name} не задано значение.`);
    }
    if (values.has(name)) {
      usageError(`Аргумент ${name} передан повторно.`);
    }
    values.set(name, value);
  }

  for (const name of allowed) {
    if (!values.has(name)) {
      usageError(`Не задан обязательный аргумент ${name}.`);
    }
  }

  const baseSha = values.get("--base-sha");
  const mergeBaseSha = values.get("--merge-base-sha");
  const headSha = values.get("--head-sha");
  if (![baseSha, mergeBaseSha, headSha].every((sha) => SHA_PATTERN.test(sha))) {
    usageError("Base SHA, merge base SHA и Head SHA должны быть полными 40-символьными SHA-1.");
  }

  return {
    baseSha,
    mergeBaseSha,
    headSha,
    diffPath: values.get("--diff-path"),
    manifestPath: values.get("--manifest-path"),
  };
}

function gitEnvironment() {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
}

function formatGitFailure(args, result) {
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.subarray(0, MAX_GIT_ERROR_BYTES).toString("utf8").trim()
    : "";
  const reason = result.error?.message ?? (stderr || `exit ${result.status}`);
  return `git ${args.join(" ")} завершился ошибкой: ${reason}`;
}

function runGitBuffer(args) {
  const result = spawnSync("git", args, {
    encoding: null,
    env: gitEnvironment(),
    maxBuffer: MAX_GIT_METADATA_BYTES,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(formatGitFailure(args, result));
  }
  return result.stdout;
}

function writeGitOutput(args, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  const descriptor = openSync(temporaryPath, "w", 0o600);
  let result;
  try {
    result = spawnSync("git", args, {
      encoding: null,
      env: gitEnvironment(),
      maxBuffer: MAX_GIT_ERROR_BYTES,
      stdio: ["ignore", descriptor, "pipe"],
    });
  } finally {
    closeSync(descriptor);
  }

  if (result.status !== 0 || result.error) {
    rmSync(temporaryPath, { force: true });
    throw new Error(formatGitFailure(args, result));
  }
  renameSync(temporaryPath, outputPath);
}

function decodeUtf8(value, label) {
  try {
    return utf8Decoder.decode(value);
  } catch {
    throw new Error(`${label} не является корректной UTF-8 строкой.`);
  }
}

function splitNul(buffer, label) {
  if (buffer.length === 0) {
    return [];
  }
  if (buffer.at(-1) !== 0) {
    throw new Error(`${label} не завершён NUL-разделителем.`);
  }

  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      values.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  return values;
}

export function parseRawDiff(buffer) {
  const tokens = splitNul(buffer, "git diff --raw -z");
  const entries = [];

  for (let index = 0; index < tokens.length;) {
    const header = decodeUtf8(tokens[index], "Заголовок raw diff");
    index += 1;
    const match = RAW_HEADER_PATTERN.exec(header);
    if (!match) {
      throw new Error(`Git вернул неожиданный raw-заголовок: ${JSON.stringify(header)}.`);
    }

    const [, oldMode, newMode, oldOid, newOid, status] = match;
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    if (index + pathCount > tokens.length) {
      throw new Error(`Raw diff оборван после статуса ${status}.`);
    }
    const paths = tokens
      .slice(index, index + pathCount)
      .map((value) => decodeUtf8(value, "Путь raw diff"));
    index += pathCount;

    const oldPresent = oldMode !== "000000" && !ZERO_SHA_PATTERN.test(oldOid);
    const newPresent = newMode !== "000000" && !ZERO_SHA_PATTERN.test(newOid);
    entries.push({
      status,
      paths,
      oldPath: oldPresent ? paths[0] : null,
      newPath: newPresent ? paths.at(-1) : null,
      oldMode: oldPresent ? oldMode : null,
      newMode: newPresent ? newMode : null,
      oldOid: oldPresent ? oldOid : null,
      newOid: newPresent ? newOid : null,
    });
  }

  return entries;
}

function parseNumstatHeader(token) {
  const firstTab = token.indexOf(0x09);
  const secondTab = firstTab === -1 ? -1 : token.indexOf(0x09, firstTab + 1);
  if (firstTab <= 0 || secondTab <= firstTab + 1) {
    throw new Error("Git вернул неожиданный заголовок numstat.");
  }
  return {
    added: token.subarray(0, firstTab).toString("ascii"),
    deleted: token.subarray(firstTab + 1, secondTab).toString("ascii"),
    inlinePath: token.subarray(secondTab + 1),
  };
}

export function parseNumstat(buffer) {
  const tokens = splitNul(buffer, "git diff --numstat -z");
  const entries = [];

  for (let index = 0; index < tokens.length;) {
    const { added, deleted, inlinePath } = parseNumstatHeader(tokens[index]);
    index += 1;
    if (!((/^\d+$/u.test(added) && /^\d+$/u.test(deleted)) || (added === "-" && deleted === "-"))) {
      throw new Error(`Git вернул неожиданные значения numstat: ${added}/${deleted}.`);
    }

    let paths;
    if (inlinePath.length > 0) {
      paths = [decodeUtf8(inlinePath, "Путь numstat")];
    } else {
      if (index + 2 > tokens.length) {
        throw new Error("Numstat rename/copy оборван до двух путей.");
      }
      paths = [
        decodeUtf8(tokens[index], "Старый путь numstat"),
        decodeUtf8(tokens[index + 1], "Новый путь numstat"),
      ];
      index += 2;
    }
    entries.push({ added, deleted, paths, binary: added === "-" });
  }

  return entries;
}

function assertMatchingEntries(rawEntries, numstatEntries) {
  if (rawEntries.length !== numstatEntries.length) {
    throw new Error(
      `Raw diff и numstat содержат разное число записей: ${rawEntries.length}/${numstatEntries.length}.`,
    );
  }

  for (let index = 0; index < rawEntries.length; index += 1) {
    const rawPaths = rawEntries[index].paths;
    const numstatPaths = numstatEntries[index].paths;
    if (
      rawPaths.length !== numstatPaths.length ||
      rawPaths.some((value, pathIndex) => value !== numstatPaths[pathIndex])
    ) {
      throw new Error(`Raw diff и numstat расходятся в записи ${index + 1}.`);
    }
  }
}

function inspectBlob(oid) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    let stderr = Buffer.alloc(0);
    const child = spawn("git", ["cat-file", "blob", oid], {
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_GIT_ERROR_BYTES) {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_GIT_ERROR_BYTES);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `git cat-file blob ${oid} завершился ошибкой: ` +
              `${stderr.toString("utf8").trim() || `exit ${code ?? signal}`}`,
          ),
        );
        return;
      }
      resolve({ oid, bytes, sha256: hash.digest("hex") });
    });
  });
}

async function buildBinaryManifest(baseSha, mergeBaseSha, headSha) {
  const rawEntries = parseRawDiff(
    runGitBuffer([
      "diff",
      "--raw",
      "-z",
      "--no-abbrev",
      "--find-renames",
      "--full-index",
      mergeBaseSha,
      headSha,
      "--",
    ]),
  );
  const numstatEntries = parseNumstat(
    runGitBuffer([
      "diff",
      "--numstat",
      "-z",
      "--find-renames",
      "--full-index",
      mergeBaseSha,
      headSha,
      "--",
    ]),
  );
  assertMatchingEntries(rawEntries, numstatEntries);

  const blobCache = new Map();
  const blob = async (oid) => {
    if (oid === null) {
      return null;
    }
    if (!blobCache.has(oid)) {
      blobCache.set(oid, inspectBlob(oid));
    }
    return blobCache.get(oid);
  };

  const files = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    if (!numstatEntries[index].binary) {
      continue;
    }
    const entry = rawEntries[index];
    files.push({
      status: entry.status,
      oldPath: entry.oldPath,
      newPath: entry.newPath,
      oldMode: entry.oldMode,
      newMode: entry.newMode,
      oldBlob: await blob(entry.oldOid),
      newBlob: await blob(entry.newOid),
    });
  }

  return { schemaVersion: 1, baseSha, mergeBaseSha, headSha, files };
}

export async function prepareCodexInput({
  baseSha,
  mergeBaseSha,
  headSha,
  diffPath,
  manifestPath,
}) {
  for (const sha of [baseSha, mergeBaseSha, headSha]) {
    runGitBuffer(["cat-file", "-e", `${sha}^{commit}`]);
  }
  const actualMergeBase = decodeUtf8(
    runGitBuffer(["merge-base", baseSha, headSha]),
    "Вычисленный merge base",
  ).trim();
  if (actualMergeBase !== mergeBaseSha) {
    throw new Error(
      `Переданный merge base ${mergeBaseSha} не совпадает с вычисленным ${actualMergeBase}.`,
    );
  }

  writeGitOutput(
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--find-renames",
      "--full-index",
      mergeBaseSha,
      headSha,
      "--",
    ],
    diffPath,
  );

  const manifest = await buildBinaryManifest(baseSha, mergeBaseSha, headSha);
  mkdirSync(dirname(manifestPath), { recursive: true });
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestContent, { encoding: "utf8", mode: 0o600 });

  return {
    diffBytes: statSync(diffPath).size,
    manifestBytes: Buffer.byteLength(manifestContent),
    binaryFiles: manifest.files.length,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await prepareCodexInput(parseArguments(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isEntrypoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
