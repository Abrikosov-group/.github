import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const COMMAND = "/binary-disposition";
const OWNER_LOGIN = "Etogerman";
const OWNER_ID = 224131170;
const ALLOWED_PERMISSIONS = new Set(["write", "maintain", "admin"]);
const ALLOWED_DECISIONS = new Set([
  "manual-review",
  "automated-check",
  "not-required",
  "accepted-risk",
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RUN_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]*)$/u;
const UNSAFE_PATH_PATTERN = /[\u0000-\u001f\u007f"\\`<>]/u;

function requireEnvironment(environment, name) {
  const value = environment[name];
  if (!value) {
    throw new Error(`Не задана обязательная переменная ${name}.`);
  }
  return value;
}

function assertPlainObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} должен быть объектом.`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} содержит неожиданные или пропущенные поля.`);
  }
}

function validateJustification(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 5 ||
    value.length > 2_000 ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label}: justification должен содержать проверяемый непустой результат.`);
  }
  return value;
}

export function parseDispositionComment(body) {
  if (typeof body !== "string" || !body.startsWith(`${COMMAND}\n`)) {
    return null;
  }
  const json = body.slice(COMMAND.length + 1).trim();
  if (!json.startsWith("{") || !json.endsWith("}")) {
    throw new Error("После /binary-disposition нужен ровно один JSON-объект без Markdown fence.");
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("Комментарий /binary-disposition содержит некорректный JSON.");
  }
}

function canonicalPaths(manifest) {
  assertPlainObject(manifest, "Binary manifest");
  if (
    manifest.schemaVersion !== 1 ||
    !SHA_PATTERN.test(manifest.headSha) ||
    !HASH_PATTERN.test(manifest.binaryManifestSha256) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Binary manifest имеет неподдерживаемый формат.");
  }
  const calculatedHash = createHash("sha256")
    .update(JSON.stringify(manifest.files))
    .digest("hex");
  if (calculatedHash !== manifest.binaryManifestSha256) {
    throw new Error("binaryManifestSha256 не совпадает с полным списком manifest.");
  }
  return manifest.files.map((file, index) => {
    const path = file?.newPath ?? file?.oldPath;
    if (typeof path !== "string" || path.length === 0 || UNSAFE_PATH_PATTERN.test(path)) {
      throw new Error(`Binary manifest file ${index + 1} не содержит path.`);
    }
    return path;
  });
}

export function validateDisposition(disposition, { manifest, actor, permission, prAuthor }) {
  assertPlainObject(disposition, "Binary disposition");
  assertExactKeys(
    disposition,
    ["schemaVersion", "headSha", "binaryManifestSha256", "files"],
    "Binary disposition",
  );
  if (
    disposition.schemaVersion !== 1 ||
    disposition.headSha !== manifest.headSha ||
    disposition.binaryManifestSha256 !== manifest.binaryManifestSha256 ||
    !Array.isArray(disposition.files)
  ) {
    throw new Error("Disposition не связан с exact Head SHA и binaryManifestSha256.");
  }
  const actorIsAuthor = actor.id === prAuthor.id;
  if (!actorIsAuthor && !ALLOWED_PERMISSIONS.has(permission)) {
    throw new Error("Автор disposition не является автором PR и не имеет live write/maintain/admin.");
  }

  const expectedPaths = canonicalPaths(manifest);
  if (disposition.files.length !== expectedPaths.length) {
    throw new Error("Disposition содержит неполный список binary paths.");
  }
  const normalizedFiles = disposition.files.map((file, index) => {
    const label = `Disposition file ${index + 1}`;
    assertPlainObject(file, label);
    const expectedKeys = file.decision === "automated-check"
      ? ["path", "decision", "justification", "runUrl"]
      : ["path", "decision", "justification"];
    assertExactKeys(file, expectedKeys, label);
    if (file.path !== expectedPaths[index]) {
      throw new Error(`${label}: path или порядок не совпадает с binary manifest.`);
    }
    if (!ALLOWED_DECISIONS.has(file.decision)) {
      throw new Error(`${label}: неизвестное решение.`);
    }
    const justification = validateJustification(file.justification, label);
    if (file.decision === "accepted-risk" && (actor.login !== OWNER_LOGIN || actor.id !== OWNER_ID)) {
      throw new Error("Решение accepted-risk разрешено только Etogerman с ожидаемым stable user ID.");
    }
    if (file.decision === "automated-check" && !RUN_URL_PATTERN.test(file.runUrl)) {
      throw new Error(`${label}: runUrl должен вести на GitHub Actions run.`);
    }
    return {
      path: file.path,
      decision: file.decision,
      justification,
      ...(file.runUrl ? { runUrl: file.runUrl } : {}),
    };
  });

  return {
    schemaVersion: 1,
    headSha: disposition.headSha,
    binaryManifestSha256: disposition.binaryManifestSha256,
    actor: { login: actor.login, id: actor.id },
    actorIsPrAuthor: actorIsAuthor,
    livePermission: permission,
    files: normalizedFiles,
  };
}

async function githubRequest(fetchImplementation, path, token, { allowNotFound = false } = {}) {
  const response = await fetchImplementation(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "abrikosov-group-binary-disposition",
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  if (allowNotFound && response.status === 404) {
    return null;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API вернул ${response.status}: ${text.slice(0, 1_000) || "пустой ответ"}`);
  }
  return text ? JSON.parse(text) : null;
}

async function verifyAutomatedRuns(record, repository, headSha, token, fetchImplementation) {
  for (const file of record.files) {
    if (file.decision !== "automated-check") {
      continue;
    }
    const match = RUN_URL_PATTERN.exec(file.runUrl);
    const runRepository = `${match[1]}/${match[2]}`;
    if (runRepository.toLowerCase() !== repository.toLowerCase()) {
      throw new Error(`Run URL для ${file.path} относится к другому репозиторию.`);
    }
    const run = await githubRequest(
      fetchImplementation,
      `/repos/${repository}/actions/runs/${match[3]}`,
      token,
    );
    if (
      run?.head_sha !== headSha ||
      run?.status !== "completed" ||
      run?.conclusion !== "success" ||
      run?.repository?.full_name?.toLowerCase() !== repository.toLowerCase()
    ) {
      throw new Error(`Run URL для ${file.path} не подтверждает успешную проверку exact Head SHA.`);
    }
  }
}

async function allComments(fetchImplementation, repository, pullNumber, token) {
  const result = [];
  for (let page = 1; ; page += 1) {
    const comments = await githubRequest(
      fetchImplementation,
      `/repos/${repository}/issues/${pullNumber}/comments?per_page=100&page=${page}`,
      token,
    );
    result.push(...comments);
    if (comments.length < 100) {
      return result;
    }
  }
}

export async function evaluateBinaryDisposition({ manifest, repository, pullNumber, token, fetchImplementation }) {
  const pr = await githubRequest(
    fetchImplementation,
    `/repos/${repository}/pulls/${pullNumber}`,
    token,
  );
  if (pr?.head?.sha !== manifest.headSha || !Number.isSafeInteger(pr?.user?.id)) {
    throw new Error("Текущий PR не совпадает с Head SHA binary manifest.");
  }
  const paths = canonicalPaths(manifest);
  if (paths.length === 0) {
    return {
      coverageClosed: true,
      code: null,
      summary: "Непроверенных бинарных файлов нет.",
      disposition: null,
    };
  }

  const comments = (await allComments(fetchImplementation, repository, pullNumber, token))
    .filter((comment) => typeof comment?.body === "string" && comment.body.startsWith(`${COMMAND}\n`))
    .sort((left, right) => right.id - left.id);
  let newestFailure = null;
  for (const comment of comments) {
    try {
      if (!Number.isSafeInteger(comment?.user?.id) || typeof comment?.user?.login !== "string") {
        throw new Error("Комментарий не содержит stable actor user ID.");
      }
      const actor = { login: comment.user.login, id: comment.user.id };
      let permission = "none";
      if (actor.id !== pr.user.id) {
        const permissionResponse = await githubRequest(
          fetchImplementation,
          `/repos/${repository}/collaborators/${encodeURIComponent(actor.login)}/permission`,
          token,
          { allowNotFound: true },
        );
        permission = permissionResponse?.permission ?? "none";
      }
      const record = validateDisposition(parseDispositionComment(comment.body), {
        manifest,
        actor,
        permission,
        prAuthor: { login: pr.user.login, id: pr.user.id },
      });
      await verifyAutomatedRuns(record, repository, manifest.headSha, token, fetchImplementation);
      return {
        coverageClosed: true,
        code: null,
        summary: `Binary disposition подтверждён комментарием ${comment.id}.`,
        disposition: { ...record, commentId: comment.id, commentUrl: comment.html_url },
      };
    } catch (error) {
      newestFailure ??= (error instanceof Error ? error.message : String(error))
        .replace(/[\r\n]+/gu, " ")
        .slice(0, 500);
    }
  }
  return {
    coverageClosed: false,
    code: "C42.1",
    summary: newestFailure ?? "Для текущего binary manifest нет disposition.",
    disposition: null,
  };
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== "--manifest-path" || argv[2] !== "--output-path") {
    throw new Error("Использование: --manifest-path <path> --output-path <path>.");
  }
  return { manifestPath: argv[1], outputPath: argv[3] };
}

export async function main(argv = process.argv.slice(2), environment = process.env, fetchImplementation = fetch) {
  const { manifestPath, outputPath } = parseArguments(argv);
  const repository = requireEnvironment(environment, "GITHUB_REPOSITORY");
  const rawPullNumber = requireEnvironment(environment, "PR_NUMBER");
  const token = requireEnvironment(environment, "GH_TOKEN");
  if (!REPOSITORY_PATTERN.test(repository) || !/^[1-9][0-9]*$/u.test(rawPullNumber)) {
    throw new Error("GITHUB_REPOSITORY или PR_NUMBER имеют недопустимый формат.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const result = await evaluateBinaryDisposition({
    manifest,
    repository,
    pullNumber: Number.parseInt(rawPullNumber, 10),
    token,
    fetchImplementation,
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isEntrypoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
