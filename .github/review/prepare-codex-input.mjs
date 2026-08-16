import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, posix } from "node:path";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ZERO_SHA_PATTERN = /^0{40}$/u;
const RAW_HEADER_PATTERN = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z][0-9]*)$/u;
const MAX_GIT_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const MAX_GIT_ERROR_BYTES = 64 * 1024;
const ENCODED_PAYLOAD_MIN_BYTES = 1_024;
const UNSAFE_MODEL_PATH_PATTERN = /[\u0000-\u001f\u007f"\\`<>\p{Cf}]/u;
const BASE85_EXTENSION_PATTERN = /\.(?:a85|ascii85|b85|base85|z85)$/iu;
const SOURCE_DECLARATION_NAMES = ["PROVENANCE.md", "SOURCES.md", "SOURCE.md", "README.md", "README"];
const LICENSE_DECLARATION_NAMES = ["OFL.txt", "LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "NOTICE"];
const MAX_DECLARATION_BYTES = 1024 * 1024;
const Z85_ALPHABET = new Set(Buffer.from(
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#",
  "ascii",
));

function startsWithBytes(value, bytes) {
  return value.length >= bytes.length && bytes.every((byte, index) => value[index] === byte);
}

function detectContentFormat(prefix, { validUtf8, containsNul, base64Payload, base85Payload }) {
  if (startsWithBytes(prefix, [0x77, 0x4f, 0x46, 0x32])) return "font/woff2";
  if (startsWithBytes(prefix, [0x77, 0x4f, 0x46, 0x46])) return "font/woff";
  if (startsWithBytes(prefix, [0x4f, 0x54, 0x54, 0x4f])) return "font/otf";
  if (startsWithBytes(prefix, [0x00, 0x01, 0x00, 0x00])) return "font/ttf";
  if (startsWithBytes(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWithBytes(prefix, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithBytes(prefix, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWithBytes(prefix, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (startsWithBytes(prefix, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWithBytes(prefix, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWithBytes(prefix, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWithBytes(prefix, [0x50, 0x4b, 0x07, 0x08])) return "application/zip";
  if (startsWithBytes(prefix, [0x1f, 0x8b])) return "application/gzip";
  if (startsWithBytes(prefix, [0x7f, 0x45, 0x4c, 0x46])) return "application/x-elf";
  if (
    startsWithBytes(prefix, [0x52, 0x49, 0x46, 0x46]) &&
    prefix.length >= 12 &&
    startsWithBytes(prefix.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) return "image/webp";
  if (base64Payload) return "application/base64";
  if (base85Payload) return "application/ascii85";
  if (validUtf8 && !containsNul) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

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
    let prefix = Buffer.alloc(0);
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
    let base64LineCharacters = 0;
    let base64LineValid = true;
    let base64WrappedBlockCharacters = 0;
    let base64WrappedBlockLines = 0;
    let base64WrappedPayloadDetected = false;
    let ascii85Open = false;
    let ascii85PendingTilde = false;
    let ascii85Characters = 0;
    let ascii85DelimitedPayload = false;
    let z85Characters = 0;
    let z85OtherCharacters = 0;
    let previousByte = null;
    let stderr = Buffer.alloc(0);
    const base64Marker = Buffer.from("base64,", "ascii");
    const finishBase64Line = () => {
      const encodedLine = base64LineValid &&
        base64LineCharacters >= 32 &&
        base64LineCharacters % 4 === 0;
      if (encodedLine) {
        base64WrappedBlockCharacters += base64LineCharacters;
        base64WrappedBlockLines += 1;
        if (
          base64WrappedBlockLines >= 2 &&
          base64WrappedBlockCharacters >= ENCODED_PAYLOAD_MIN_BYTES
        ) {
          base64WrappedPayloadDetected = true;
        }
      } else {
        base64WrappedBlockCharacters = 0;
        base64WrappedBlockLines = 0;
      }
      base64LineCharacters = 0;
      base64LineValid = true;
    };
    const child = spawn("git", ["cat-file", "blob", oid], {
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
      if (prefix.length < 16) {
        prefix = Buffer.concat([prefix, chunk]).subarray(0, 16);
      }
      containsNul ||= chunk.includes(0);
      for (const byte of chunk) {
        const base64Character =
          (byte >= 0x41 && byte <= 0x5a) ||
          (byte >= 0x61 && byte <= 0x7a) ||
          (byte >= 0x30 && byte <= 0x39) ||
          byte === 0x2b || byte === 0x2f || byte === 0x3d;
        const whitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20;
        if (byte === 0x0a) {
          finishBase64Line();
        } else if (byte !== 0x0d) {
          if (base64Character) {
            base64LineCharacters += 1;
          } else {
            base64LineValid = false;
          }
        }
        const z85Character = Z85_ALPHABET.has(byte);
        if (z85Character) {
          z85Characters += 1;
        } else if (!whitespace) {
          z85OtherCharacters += 1;
        }
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
      if (base64LineCharacters > 0 || !base64LineValid) {
        finishBase64Line();
      }
      const base64Payload = bytes >= ENCODED_PAYLOAD_MIN_BYTES && (
        longestBase64Run >= ENCODED_PAYLOAD_MIN_BYTES ||
        base64MarkedPayloadDetected ||
        base64WrappedPayloadDetected ||
        (
          base64OtherCharacters === 0 &&
          base64Characters / bytes >= 0.95
        )
      );
      const base85Payload = bytes >= ENCODED_PAYLOAD_MIN_BYTES && (
        ascii85DelimitedPayload
      );
      const z85Payload = bytes >= ENCODED_PAYLOAD_MIN_BYTES &&
        z85OtherCharacters === 0 && z85Characters / bytes >= 0.95;
      const encodedPayload = base64Payload || base85Payload;
      const format = detectContentFormat(prefix, {
        validUtf8,
        containsNul,
        base64Payload,
        base85Payload,
      });
      const magicBinary = format !== "text/plain; charset=utf-8" &&
        format !== "application/base64" && format !== "application/ascii85";
      resolve({
        objectType,
        binary: containsNul || !validUtf8 || encodedPayload || magicBinary,
        z85Payload,
        binaryReason: base64Payload
          ? "base64-content"
          : base85Payload
            ? "base85-content"
            : magicBinary
              ? "detected-format"
              : "binary-content",
        blob: { oid, bytes, sha256: hash.digest("hex"), format },
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

function listTree(commitSha) {
  const entries = new Map();
  for (const token of splitNul(
    runGitBuffer(["ls-tree", "-r", "-z", "--full-tree", commitSha]),
    `git ls-tree ${commitSha}`,
  )) {
    const tab = token.indexOf(0x09);
    if (tab < 1) {
      throw new Error(`Git вернул неожиданный ls-tree для ${commitSha}.`);
    }
    const metadata = token.subarray(0, tab).toString("ascii");
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})$/u.exec(metadata);
    if (!match || match[2] !== "blob") {
      continue;
    }
    const described = describePath(token.subarray(tab + 1));
    if (described.pathEncoding === "utf8") {
      entries.set(described.path, { mode: match[1], oid: match[3] });
    }
  }
  return entries;
}

function ancestorDirectories(filePath) {
  const directories = [];
  let current = posix.dirname(filePath);
  while (true) {
    directories.push(current === "." ? "" : current);
    if (current === "." || current === "/") {
      break;
    }
    current = posix.dirname(current);
  }
  return directories;
}

function joinRepositoryPath(directory, name) {
  return directory ? `${directory}/${name}` : name;
}

async function declarationReference({
  filePath,
  blobSha256,
  tree,
  object,
  kind,
}) {
  if (!filePath || filePath.startsWith("git-bytes:")) {
    return null;
  }
  const candidates = kind === "license"
    ? LICENSE_DECLARATION_NAMES.map((name) => joinRepositoryPath(
        posix.dirname(filePath) === "." ? "" : posix.dirname(filePath),
        name,
      ))
    : ancestorDirectories(filePath).flatMap((directory) =>
        SOURCE_DECLARATION_NAMES.map((name) => joinRepositoryPath(directory, name)));

  for (const candidate of candidates) {
    const treeEntry = tree.get(candidate);
    if (!treeEntry || !["100644", "100755"].includes(treeEntry.mode)) {
      continue;
    }
    const candidateObject = await object(treeEntry.oid, treeEntry.mode);
    if (
      candidateObject?.objectType !== "blob" ||
      candidateObject.binary ||
      !candidateObject.blob ||
      candidateObject.blob.bytes > MAX_DECLARATION_BYTES
    ) {
      continue;
    }
    if (kind === "source") {
      const content = decodeUtf8(
        runGitBuffer(["cat-file", "blob", treeEntry.oid], MAX_DECLARATION_BYTES),
        `Файл источника ${candidate}`,
      ).toLocaleLowerCase("en-US");
      if (
        !content.includes(blobSha256.toLocaleLowerCase("en-US")) &&
        !content.includes(posix.basename(filePath).toLocaleLowerCase("en-US"))
      ) {
        continue;
      }
    }
    return {
      path: candidate,
      bytes: candidateObject.blob.bytes,
      sha256: candidateObject.blob.sha256,
    };
  }
  return null;
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
  const oldTree = listTree(mergeBaseSha);
  const newTree = listTree(headSha);

  const objectCache = new Map();
  const object = async (oid, mode) => {
    if (oid === null) {
      return null;
    }
    if (mode === "160000") {
      return { objectType: "gitlink", blob: null, binary: false };
    }
    if (!objectCache.has(oid)) {
      objectCache.set(oid, inspectObject(oid));
    }
    return objectCache.get(oid);
  };

  const files = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = rawEntries[index];
    const oldObject = await object(entry.oldOid, entry.oldMode);
    const newObject = await object(entry.newOid, entry.newMode);
    const unsafePath = [entry.oldPath, entry.newPath]
      .some((path) => path !== null && !path.modelSafe);
    const oldBase85 = Boolean(
      entry.oldPath?.pathEncoding === "utf8" &&
      BASE85_EXTENSION_PATTERN.test(entry.oldPath.path) && oldObject?.z85Payload,
    );
    const newBase85 = Boolean(
      entry.newPath?.pathEncoding === "utf8" &&
      BASE85_EXTENSION_PATTERN.test(entry.newPath.path) && newObject?.z85Payload,
    );
    const oldBinary = Boolean(oldObject?.binary || oldBase85);
    const newBinary = Boolean(newObject?.binary || newBase85);
    const binary = oldBinary || newBinary;
    entry.oldObject = oldObject;
    entry.newObject = newObject;
    entry.oldBinary = oldBinary;
    entry.newBinary = newBinary;
    entry.omitContent = binary;
    entry.rebuildTextPatch = Boolean(!binary && (unsafePath || numstatEntries[index].binary));
    entry.binaryTransition = Boolean(
      oldObject?.objectType === "blob" && newObject?.objectType === "blob" &&
      oldBinary !== newBinary,
    );

    if (!entry.omitContent) {
      continue;
    }
    const oldPath = manifestPath(entry.oldPath);
    const newPath = manifestPath(entry.newPath);
    const oldSource = oldBinary
      ? await declarationReference({
          filePath: oldPath.path,
          blobSha256: oldObject.blob.sha256,
          tree: oldTree,
          object,
          kind: "source",
        })
      : null;
    const newSource = newBinary
      ? await declarationReference({
          filePath: newPath.path,
          blobSha256: newObject.blob.sha256,
          tree: newTree,
          object,
          kind: "source",
        })
      : null;
    const oldLicense = oldBinary
      ? await declarationReference({
          filePath: oldPath.path,
          blobSha256: oldObject.blob.sha256,
          tree: oldTree,
          object,
          kind: "license",
        })
      : null;
    const newLicense = newBinary
      ? await declarationReference({
          filePath: newPath.path,
          blobSha256: newObject.blob.sha256,
          tree: newTree,
          object,
          kind: "license",
        })
      : null;
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
      oldBlob: oldBinary
        ? {
            ...oldObject.blob,
            format: oldBase85 ? "application/z85" : oldObject.blob.format,
            source: oldSource,
            license: oldLicense,
          }
        : null,
      newBlob: newBinary
        ? {
            ...newObject.blob,
            format: newBase85 ? "application/z85" : newObject.blob.format,
            source: newSource,
            license: newLicense,
          }
        : null,
      reason: oldBase85 || newBase85
        ? "base85-content"
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
      schemaVersion: 2,
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

function splitTextLines(content) {
  if (content.length === 0) {
    return { lines: [], hasFinalNewline: true };
  }
  const hasFinalNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasFinalNewline) {
    lines.pop();
  }
  return { lines, hasFinalNewline };
}

function fullReplacementHunk(oldContent, newContent) {
  const oldSide = splitTextLines(oldContent ?? "");
  const newSide = splitTextLines(newContent ?? "");
  if (oldSide.lines.length === 0 && newSide.lines.length === 0) {
    return "";
  }
  const oldRange = oldSide.lines.length === 0 ? "0,0" : `1,${oldSide.lines.length}`;
  const newRange = newSide.lines.length === 0 ? "0,0" : `1,${newSide.lines.length}`;
  const body = [];
  body.push(...oldSide.lines.map((line) => `-${line}`));
  if (oldSide.lines.length > 0 && !oldSide.hasFinalNewline) {
    body.push("\\ No newline at end of file");
  }
  body.push(...newSide.lines.map((line) => `+${line}`));
  if (newSide.lines.length > 0 && !newSide.hasFinalNewline) {
    body.push("\\ No newline at end of file");
  }
  return `@@ -${oldRange} +${newRange} @@\n${body.join("\n")}\n`;
}

function usesRawPatch(entry) {
  return !entry.omitContent && !entry.rebuildTextPatch;
}

function runGitFilteredPatch(args, entries) {
  if (entries.length === 0) {
    return Promise.resolve(Buffer.alloc(0));
  }

  return new Promise((resolve, reject) => {
    const boundary = Buffer.from("\ndiff --git ");
    const prefix = boundary.subarray(1);
    const output = [];
    let outputBytes = 0;
    let pending = Buffer.alloc(0);
    let currentEntry = 0;
    let verifiedPrefix = false;
    let parseError = null;
    let spawnError = null;
    let stderr = Buffer.alloc(0);
    const child = spawn("git", args, {
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const emit = (value) => {
      if (value.length === 0 || !usesRawPatch(entries[currentEntry])) {
        return;
      }
      outputBytes += value.length;
      if (outputBytes > MAX_PATCH_BYTES) {
        throw new Error(`Безопасный текстовый diff больше ${MAX_PATCH_BYTES} байт.`);
      }
      output.push(value);
    };

    const consume = () => {
      if (!verifiedPrefix) {
        if (pending.length < prefix.length) {
          return;
        }
        if (!pending.subarray(0, prefix.length).equals(prefix)) {
          throw new Error("Git patch не начинается с ожидаемого заголовка diff --git.");
        }
        verifiedPrefix = true;
      }

      let index;
      while ((index = pending.indexOf(boundary)) !== -1) {
        emit(pending.subarray(0, index + 1));
        currentEntry += 1;
        if (currentEntry >= entries.length) {
          throw new Error("Git patch содержит больше записей, чем raw diff.");
        }
        pending = pending.subarray(index + 1);
      }

      const flushBytes = Math.max(0, pending.length - (boundary.length - 1));
      emit(pending.subarray(0, flushBytes));
      pending = pending.subarray(flushBytes);
    };

    child.stdout.on("data", (chunk) => {
      if (parseError !== null) {
        return;
      }
      try {
        pending = Buffer.concat([pending, chunk]);
        consume();
      } catch (error) {
        parseError = error;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_GIT_ERROR_BYTES) {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_GIT_ERROR_BYTES);
      }
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      if (parseError !== null) {
        reject(parseError);
        return;
      }
      if (code !== 0 || spawnError !== null) {
        reject(new Error(formatGitFailure(args, {
          stderr,
          status: code ?? signal,
          error: spawnError,
        })));
        return;
      }
      try {
        if (!verifiedPrefix) {
          throw new Error("Git patch оказался пустым при непустом raw diff.");
        }
        emit(pending);
        if (currentEntry + 1 !== entries.length) {
          throw new Error(
            `Raw diff и потоковый patch содержат разное число записей: ` +
              `${entries.length}/${currentEntry + 1}.`,
          );
        }
        resolve(Buffer.concat(output, outputBytes));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readSafeTextSide(object, label) {
  if (!object?.blob) {
    return null;
  }
  if (object.blob.bytes > MAX_PATCH_BYTES) {
    throw new Error(`${label} больше допустимого безопасного diff ${MAX_PATCH_BYTES} байт.`);
  }
  return decodeUtf8(
    runGitBuffer(["cat-file", "blob", object.blob.oid], MAX_PATCH_BYTES),
    label,
  );
}

function rebuiltTextPatch(entry, binaryCounterpart = false) {
  const oldContent = entry.oldObject?.objectType === "blob" && !entry.oldBinary
    ? readSafeTextSide(entry.oldObject, "Старая текстовая сторона")
    : null;
  const newContent = entry.newObject?.objectType === "blob" && !entry.newBinary
    ? readSafeTextSide(entry.newObject, "Новая текстовая сторона")
    : null;
  if (oldContent === null && newContent === null) {
    return omittedPatch(entry);
  }
  const oldName = entry.oldPath?.path ?? entry.newPath?.path ?? "неизвестный-путь";
  const newName = entry.newPath?.path ?? entry.oldPath?.path ?? "неизвестный-путь";
  const lines = [
    `diff --git a/${oldName} b/${newName}`,
    "review-safe-reconstructed-patch true",
    `--- ${oldContent === null ? "/dev/null" : `a/${oldName}`}`,
    `+++ ${newContent === null ? "/dev/null" : `b/${newName}`}`,
  ];
  const hunk = fullReplacementHunk(oldContent, newContent).trimEnd();
  if (hunk) {
    lines.push(hunk);
  }
  if (binaryCounterpart) {
    lines.push("Binary counterpart omitted; see binary-manifest.json.");
  }
  lines.push("");
  return Buffer.from(lines.join("\n"), "utf8");
}

function sanitizePatch(patch, entries) {
  const rawEntries = entries.filter(usesRawPatch);
  const chunks = splitPatchChunks(patch, rawEntries.length);
  let rawIndex = 0;
  const safeChunks = entries.map((entry) => {
    if (usesRawPatch(entry)) {
      const chunk = chunks[rawIndex];
      rawIndex += 1;
      return chunk;
    }
    if (!entry.omitContent) {
      return rebuiltTextPatch(entry);
    }
    return entry.binaryTransition ? rebuiltTextPatch(entry, true) : omittedPatch(entry);
  });
  if (rawIndex !== chunks.length) {
    throw new Error("Не все записи raw patch были использованы при безопасной сборке.");
  }
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

  const { manifest, entries } = await buildBinaryManifest(baseSha, mergeBaseSha, headSha);
  const rawPatch = await runGitFilteredPatch(
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--find-renames",
      "--full-index",
      "--diff-algorithm=myers",
      "--unified=3",
      "--inter-hunk-context=0",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      mergeBaseSha,
      headSha,
      "--",
    ],
    entries,
  );
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
