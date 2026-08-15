import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ZERO_SHA_PATTERN = /^0{40}$/u;
const RAW_HEADER_PATTERN = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z][0-9]*)$/u;
const MAX_GIT_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const MAX_GIT_ERROR_BYTES = 64 * 1024;
const ENCODED_PAYLOAD_MIN_BYTES = 1_024;
const UNSAFE_MODEL_PATH_PATTERN = /[\u0000-\u001f\u007f"\\`<>\p{Cf}]/u;
const BINARY_EXTENSION_PATTERN = /\.(?:7z|avi|avif|bin|bmp|bz2|class|dll|dmg|docx?|eot|exe|flac|gif|gz|ico|jar|jpe?g|m4a|mkv|mov|mp3|mp4|o|od[fpst]|ogg|otf|pdf|png|pptx?|rar|so|tar|tiff?|ttf|wav|webm|webp|woff2?|xlsx?|xz|zip)$/iu;
const Z85_ALPHABET = new Set(Buffer.from(
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#",
  "ascii",
));

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

function runGitBuffer(args, maxBuffer = MAX_GIT_METADATA_BYTES) {
  const result = spawnSync("git", args, {
    encoding: null,
    env: gitEnvironment(),
    maxBuffer,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(formatGitFailure(args, result));
  }
  return result.stdout;
}

function decodeUtf8(value, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(`${label} не является корректной UTF-8 строкой.`);
  }
}

function describePath(value) {
  try {
    const path = decodeUtf8(value, "Путь Git");
    if (UNSAFE_MODEL_PATH_PATTERN.test(path)) {
      return {
        path: `git-bytes:${value.toString("hex")}`,
        pathEncoding: "hex",
        pathBytesHex: value.toString("hex"),
        modelSafe: false,
      };
    }
    return {
      path,
      pathEncoding: "utf8",
      pathBytesHex: null,
      modelSafe: true,
    };
  } catch {
    return {
      path: `git-bytes:${value.toString("hex")}`,
      pathEncoding: "hex",
      pathBytesHex: value.toString("hex"),
      modelSafe: false,
    };
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
    const pathBytes = tokens.slice(index, index + pathCount);
    const paths = pathBytes.map((value) => describePath(value));
    index += pathCount;

    const oldPresent = oldMode !== "000000" && !ZERO_SHA_PATTERN.test(oldOid);
    const newPresent = newMode !== "000000" && !ZERO_SHA_PATTERN.test(newOid);
    entries.push({
      status,
      pathBytes,
      paths: paths.map((value) => value.path),
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
      paths = [Buffer.from(inlinePath)];
    } else {
      if (index + 2 > tokens.length) {
        throw new Error("Numstat rename/copy оборван до двух путей.");
      }
      paths = [
        Buffer.from(tokens[index]),
        Buffer.from(tokens[index + 1]),
      ];
      index += 2;
    }
    entries.push({ added, deleted, pathBytes: paths, binary: added === "-" });
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
    const rawPaths = rawEntries[index].pathBytes;
    const numstatPaths = numstatEntries[index].pathBytes;
    if (
      rawPaths.length !== numstatPaths.length ||
      rawPaths.some((value, pathIndex) => !value.equals(numstatPaths[pathIndex]))
    ) {
      throw new Error(`Raw diff и numstat расходятся в записи ${index + 1}.`);
    }
  }
}

function inspectObject(oid) {
  if (oid === null) {
    return Promise.resolve(null);
  }
  const objectType = decodeUtf8(runGitBuffer(["cat-file", "-t", oid]), "Тип Git object").trim();
  if (objectType !== "blob") {
    return Promise.resolve({ objectType, blob: null, binary: false });
  }

  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let containsNul = false;
    let validUtf8 = true;
    let base64Characters = 0;
    let base64OtherCharacters = 0;
    let base64Run = 0;
    let longestBase64Run = 0;
    let base64MarkerIndex = 0;
    let base64MarkedPayload = false;
    let base64MarkedCharacters = 0;
    let base64MarkedPayloadDetected = false;
    let base85Characters = 0;
    let base85OtherCharacters = 0;
    let z85Characters = 0;
    let z85OtherCharacters = 0;
    let z85Run = 0;
    let longestZ85Run = 0;
    let ascii85Open = false;
    let ascii85PendingTilde = false;
    let ascii85Characters = 0;
    let ascii85DelimitedPayload = false;
    let previousByte = null;
    let stderr = Buffer.alloc(0);
    const base64Marker = Buffer.from("base64,", "ascii");
    const child = spawn("git", ["cat-file", "blob", oid], {
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
      containsNul ||= chunk.includes(0);
      for (const byte of chunk) {
        const base64Character =
          (byte >= 0x41 && byte <= 0x5a) ||
          (byte >= 0x61 && byte <= 0x7a) ||
          (byte >= 0x30 && byte <= 0x39) ||
          byte === 0x2b || byte === 0x2f || byte === 0x3d;
        const whitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20;
        if (base64Character) {
          base64Characters += 1;
          base64Run += 1;
          longestBase64Run = Math.max(longestBase64Run, base64Run);
        } else {
          base64Run = 0;
        }
        if (!base64Character && !whitespace) {
          base64OtherCharacters += 1;
        }

        const lowerByte = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
        if (base64MarkedPayload) {
          if (base64Character) {
            base64MarkedCharacters += 1;
            if (base64MarkedCharacters >= ENCODED_PAYLOAD_MIN_BYTES) {
              base64MarkedPayloadDetected = true;
              base64MarkedPayload = false;
            }
          } else if (!whitespace) {
            base64MarkedPayload = false;
            base64MarkedCharacters = 0;
          }
        }
        if (!base64MarkedPayload) {
          if (lowerByte === base64Marker[base64MarkerIndex]) {
            base64MarkerIndex += 1;
            if (base64MarkerIndex === base64Marker.length) {
              base64MarkedPayload = true;
              base64MarkedCharacters = 0;
              base64MarkerIndex = 0;
            }
          } else {
            base64MarkerIndex = lowerByte === base64Marker[0] ? 1 : 0;
          }
        }

        const base85Character = byte >= 0x21 && byte <= 0x75;
        if (base85Character) {
          base85Characters += 1;
        } else if (!whitespace) {
          base85OtherCharacters += 1;
        }
        if (Z85_ALPHABET.has(byte)) {
          z85Characters += 1;
          z85Run += 1;
          longestZ85Run = Math.max(longestZ85Run, z85Run);
        } else {
          z85Run = 0;
          if (!whitespace) {
            z85OtherCharacters += 1;
          }
        }
        if (ascii85Open) {
          if (ascii85PendingTilde) {
            if (byte === 0x3e) {
              ascii85DelimitedPayload ||= ascii85Characters >= ENCODED_PAYLOAD_MIN_BYTES;
            }
            ascii85Open = false;
            ascii85PendingTilde = false;
            ascii85Characters = 0;
          } else if (byte === 0x7e) {
            ascii85PendingTilde = true;
          } else if (base85Character) {
            ascii85Characters += 1;
          } else if (!whitespace) {
            ascii85Open = false;
            ascii85Characters = 0;
          }
        } else if (previousByte === 0x3c && byte === 0x7e) {
          ascii85Open = true;
          ascii85Characters = 0;
        }
        previousByte = byte;
      }
      if (validUtf8) {
        try {
          decoder.decode(chunk, { stream: true });
        } catch {
          validUtf8 = false;
        }
      }
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
      if (validUtf8) {
        try {
          decoder.decode();
        } catch {
          validUtf8 = false;
        }
      }
      const base64Payload = bytes >= ENCODED_PAYLOAD_MIN_BYTES && (
        longestBase64Run >= ENCODED_PAYLOAD_MIN_BYTES ||
        base64MarkedPayloadDetected ||
        (
          base64OtherCharacters === 0 &&
          base64Characters / bytes >= 0.95
        )
      );
      const base85Payload = bytes >= ENCODED_PAYLOAD_MIN_BYTES && (
        ascii85DelimitedPayload ||
        longestZ85Run >= ENCODED_PAYLOAD_MIN_BYTES ||
        (base85OtherCharacters === 0 && base85Characters / bytes >= 0.95) ||
        (z85OtherCharacters === 0 && z85Characters / bytes >= 0.95)
      );
      const encodedPayload = base64Payload || base85Payload;
      resolve({
        objectType,
        binary: containsNul || !validUtf8 || encodedPayload,
        binaryReason: base64Payload
          ? "base64-content"
          : base85Payload
            ? "base85-content"
            : "binary-content",
        blob: { oid, bytes, sha256: hash.digest("hex") },
      });
    });
  });
}

function manifestPath(path) {
  if (path === null) {
    return { path: null, pathEncoding: null, pathBytesHex: null };
  }
  return {
    path: path.path,
    pathEncoding: path.pathEncoding,
    pathBytesHex: path.pathBytesHex,
  };
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

  const objectCache = new Map();
  const object = async (oid) => {
    if (oid === null) {
      return null;
    }
    if (!objectCache.has(oid)) {
      objectCache.set(oid, inspectObject(oid));
    }
    return objectCache.get(oid);
  };

  const files = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = rawEntries[index];
    const oldObject = await object(entry.oldOid);
    const newObject = await object(entry.newOid);
    const unsafePath = [entry.oldPath, entry.newPath]
      .some((path) => path !== null && !path.modelSafe);
    const binaryExtension = [entry.oldPath, entry.newPath]
      .some((path) => path?.pathEncoding === "utf8" && BINARY_EXTENSION_PATTERN.test(path.path));
    const binary = numstatEntries[index].binary || oldObject?.binary || newObject?.binary || binaryExtension;
    entry.oldObject = oldObject;
    entry.newObject = newObject;
    entry.omitContent = Boolean(binary || unsafePath);
    entry.binaryTransition = Boolean(
      oldObject?.objectType === "blob" && newObject?.objectType === "blob" &&
      oldObject.binary !== newObject.binary && !unsafePath && !binaryExtension,
    );

    if (!entry.omitContent) {
      continue;
    }
    const oldPath = manifestPath(entry.oldPath);
    const newPath = manifestPath(entry.newPath);
    files.push({
      status: entry.status,
      oldPath: oldPath.path,
      newPath: newPath.path,
      oldPathEncoding: oldPath.pathEncoding,
      newPathEncoding: newPath.pathEncoding,
      oldPathBytesHex: oldPath.pathBytesHex,
      newPathBytesHex: newPath.pathBytesHex,
      oldMode: entry.oldMode,
      newMode: entry.newMode,
      oldBlob: oldObject?.blob ?? null,
      newBlob: newObject?.blob ?? null,
      reason: unsafePath
        ? "opaque-path"
        : binaryExtension
          ? "binary-extension"
          : oldObject?.binaryReason === "base64-content" || newObject?.binaryReason === "base64-content"
            ? "base64-content"
            : oldObject?.binaryReason === "base85-content" || newObject?.binaryReason === "base85-content"
              ? "base85-content"
            : "binary-content",
    });
  }

  const binaryManifestSha256 = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  return {
    manifest: {
      schemaVersion: 1,
      baseSha,
      mergeBaseSha,
      headSha,
      binaryManifestSha256,
      files,
    },
    entries: rawEntries,
  };
}

function splitPatchChunks(patch, expectedCount) {
  const marker = Buffer.from("\ndiff --git ");
  const starts = patch.subarray(0, 11).equals(Buffer.from("diff --git ")) ? [0] : [];
  let offset = 0;
  while ((offset = patch.indexOf(marker, offset)) !== -1) {
    starts.push(offset + 1);
    offset += marker.length;
  }
  if (starts.length !== expectedCount) {
    throw new Error(`Raw diff и patch содержат разное число записей: ${expectedCount}/${starts.length}.`);
  }
  return starts.map((start, index) => patch.subarray(start, starts[index + 1] ?? patch.length));
}

function canonicalPath(entry) {
  return entry.newPath?.path ?? entry.oldPath?.path ?? "неизвестный-путь";
}

function omittedPatch(entry) {
  const path = canonicalPath(entry);
  return Buffer.from(
    `diff --git a/${path} b/${path}\n` +
      "Binary or non-representable content omitted; see binary-manifest.json.\n",
    "utf8",
  );
}

function wholeFileHunk(content, prefix, oldSide) {
  if (content.length === 0) {
    return "";
  }
  const hasFinalNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasFinalNewline) {
    lines.pop();
  }
  const count = lines.length;
  const range = oldSide ? `@@ -1,${count} +0,0 @@` : `@@ -0,0 +1,${count} @@`;
  const body = lines.map((line) => `${prefix}${line}`).join("\n");
  return `${range}\n${body}\n${hasFinalNewline ? "" : "\\ No newline at end of file\n"}`;
}

function transitionPatch(entry) {
  const oldIsText = entry.oldObject?.objectType === "blob" && !entry.oldObject.binary;
  const textObject = oldIsText ? entry.oldObject : entry.newObject;
  const textPath = oldIsText ? entry.oldPath.path : entry.newPath.path;
  if (!textObject?.blob || textObject.blob.bytes > MAX_PATCH_BYTES) {
    return omittedPatch(entry);
  }
  const content = decodeUtf8(
    runGitBuffer(["cat-file", "blob", textObject.blob.oid], MAX_PATCH_BYTES),
    "Текстовая сторона binary transition",
  );
  const oldPath = oldIsText ? `a/${textPath}` : "/dev/null";
  const newPath = oldIsText ? "/dev/null" : `b/${textPath}`;
  return Buffer.from([
    `diff --git a/${textPath} b/${textPath}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    wholeFileHunk(content, oldIsText ? "-" : "+", oldIsText).trimEnd(),
    "Binary counterpart omitted; see binary-manifest.json.",
    "",
  ].filter((line, index) => line !== "" || index === 5).join("\n"), "utf8");
}

function sanitizePatch(patch, entries) {
  const chunks = splitPatchChunks(patch, entries.length);
  const safeChunks = chunks.map((chunk, index) => {
    const entry = entries[index];
    if (!entry.omitContent) {
      return chunk;
    }
    return entry.binaryTransition ? transitionPatch(entry) : omittedPatch(entry);
  });
  const result = Buffer.concat(safeChunks);
  if (result.includes(0)) {
    throw new Error("Подготовленный diff всё ещё содержит NUL-байт.");
  }
  decodeUtf8(result, "Подготовленный diff");
  return result;
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

  const rawPatch = runGitBuffer(
    [
      "-c",
      "core.quotePath=false",
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
    MAX_PATCH_BYTES,
  );

  const { manifest, entries } = await buildBinaryManifest(baseSha, mergeBaseSha, headSha);
  const safePatch = sanitizePatch(rawPatch, entries);
  mkdirSync(dirname(diffPath), { recursive: true });
  writeFileSync(diffPath, safePatch, { mode: 0o600 });
  mkdirSync(dirname(manifestPath), { recursive: true });
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestContent, { encoding: "utf8", mode: 0o600 });

  return {
    diffBytes: statSync(diffPath).size,
    manifestBytes: Buffer.byteLength(manifestContent),
    binaryFiles: manifest.files.length,
    binaryManifestSha256: manifest.binaryManifestSha256,
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
