import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_FINDINGS = 20;
const MAX_PATH_LENGTH = 512;
const MAX_TITLE_LENGTH = 160;
const MAX_BODY_LENGTH = 2_000;
const MAX_DIFF_BYTES = 50 * 1024 * 1024;
const PRIORITIES = new Set(["P0", "P1", "P2"]);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REVIEW_MODELS = new Map([
  ["claude-sonnet-5", {
    displayName: "Claude Sonnet 5",
    marker: "claude-review",
    reviewer: "Claude",
  }],
  ["claude-opus-5", {
    displayName: "Claude Opus 5",
    marker: "claude-review",
    reviewer: "Claude",
  }],
  ["gpt-5.3-codex-spark", {
    displayName: "GPT-5.3-Codex-Spark",
    marker: "codex-review",
    reviewer: "Codex",
  }],
]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/u;
const HIDDEN_CONTENT_PATTERN = /<!--|-->|[\u200b-\u200f\u2060\ufeff]/iu;
const SENSITIVE_DATA_PATTERNS = [
  /(?:sk-ant-|github_pat_|gh[pousr]_)[A-Za-z0-9._-]{8,}/iu,
  /\b(?:sk-proj-|sk-svcacct-|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/iu,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/u,
  /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}\b/u,
  /\b(?:telegram[_ -]?(?:user[_ -]?)?id|tg[_ -]?id)\s*[:=]?\s*\d{5,15}\b/iu,
  /\bpayment[_ -]?payload\s*[:=]\s*[A-Za-z0-9._-]{8,}\b/iu,
];

function containsSensitiveData(value) {
  return SENSITIVE_DATA_PATTERNS.some((pattern) => pattern.test(value));
}

function assertPlainObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} должен быть объектом.`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();

  if (actualKeys.length !== expected.length || actualKeys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} содержит неожиданные поля.`);
  }
}

function assertSafeText(value, { label, maximumLength, multiline, requireRussian = false }) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new Error(`${label} должен быть непустой строкой длиной не более ${maximumLength} символов.`);
  }

  if (value !== value.trim()) {
    throw new Error(`${label} не должен начинаться или заканчиваться пробелом.`);
  }

  if ((!multiline && /[\r\n]/u.test(value)) || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} содержит недопустимые управляющие символы.`);
  }

  if (HIDDEN_CONTENT_PATTERN.test(value)) {
    throw new Error(`${label} содержит скрытую разметку.`);
  }

  if (containsSensitiveData(value)) {
    throw new Error(`${label} похоже на секрет или персональные данные; публикация остановлена.`);
  }

  if (requireRussian) {
    const prose = value
      .replace(/```[\s\S]*?```/gu, " ")
      .replace(/`[^`\n]*`/gu, " ")
      .replace(/https?:\/\/\S+/gu, " ");
    const letters = prose.match(/\p{L}/gu) ?? [];
    const russianLetters = prose.match(/[А-ЯЁа-яё]/gu) ?? [];

    if (russianLetters.length < 3 || russianLetters.length / letters.length < 0.5) {
      throw new Error(`${label} должен содержать преимущественно русский текст.`);
    }
  }

  return value;
}

function validatePath(value) {
  assertSafeText(value, {
    label: "Путь finding",
    maximumLength: MAX_PATH_LENGTH,
    multiline: false,
  });

  if (
    value.startsWith("/") ||
    value.startsWith(":") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Недопустимый путь finding: ${JSON.stringify(value)}.`);
  }

  return value;
}

export function validateReviewJson(rawReview) {
  let review;
  try {
    review = typeof rawReview === "string" ? JSON.parse(rawReview) : rawReview;
  } catch {
    throw new Error("ИИ-ревьюер вернул некорректный JSON.");
  }

  assertPlainObject(review, "Результат ИИ-ревью");
  assertExactKeys(review, ["findings"], "Результат ИИ-ревью");

  if (!Array.isArray(review.findings) || review.findings.length > MAX_FINDINGS) {
    throw new Error(`Поле findings должно быть массивом не более чем из ${MAX_FINDINGS} элементов.`);
  }

  const anchors = new Set();
  const findings = review.findings.map((finding, index) => {
    const label = `Finding ${index + 1}`;
    assertPlainObject(finding, label);
    assertExactKeys(finding, ["priority", "path", "line", "side", "title", "body"], label);

    if (!PRIORITIES.has(finding.priority)) {
      throw new Error(`${label}: priority должен быть P0, P1 или P2.`);
    }

    const path = validatePath(finding.path);
    if (!Number.isSafeInteger(finding.line) || finding.line < 1 || finding.line > 10_000_000) {
      throw new Error(`${label}: line должен быть положительным целым номером строки.`);
    }
    if (finding.side !== "LEFT" && finding.side !== "RIGHT") {
      throw new Error(`${label}: side должен быть LEFT или RIGHT.`);
    }

    const title = assertSafeText(finding.title, {
      label: `${label}: title`,
      maximumLength: MAX_TITLE_LENGTH,
      multiline: false,
      requireRussian: true,
    });
    const body = assertSafeText(finding.body, {
      label: `${label}: body`,
      maximumLength: MAX_BODY_LENGTH,
      multiline: true,
      requireRussian: true,
    });

    const anchor = `${path}\u0000${finding.side}\u0000${finding.line}`;
    if (anchors.has(anchor)) {
      throw new Error(`${label}: для одной строки разрешено только одно объединённое замечание.`);
    }
    anchors.add(anchor);

    return {
      priority: finding.priority,
      path,
      line: finding.line,
      side: finding.side,
      title,
      body,
    };
  });

  return { findings };
}

export function collectDiffLines(diff) {
  if (typeof diff !== "string") {
    throw new Error("Diff должен быть строкой.");
  }

  const lines = { LEFT: new Set(), RIGHT: new Set() };
  const hunkPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu;

  for (const match of diff.matchAll(hunkPattern)) {
    const leftStart = Number.parseInt(match[1], 10);
    const leftCount = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    const rightStart = Number.parseInt(match[3], 10);
    const rightCount = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);

    for (let line = leftStart; line < leftStart + leftCount; line += 1) {
      lines.LEFT.add(line);
    }
    for (let line = rightStart; line < rightStart + rightCount; line += 1) {
      lines.RIGHT.add(line);
    }
  }

  return lines;
}

function parseDiffHeaderPath(header, expectedPrefix) {
  if (header === "/dev/null") {
    return null;
  }
  if (!header.startsWith(expectedPrefix)) {
    throw new Error(`Некорректный путь в заголовке diff: ${JSON.stringify(header)}.`);
  }
  return header.slice(expectedPrefix.length);
}

export function collectDiffAnchors(diff) {
  if (typeof diff !== "string") {
    throw new Error("Diff должен быть строкой.");
  }

  const anchorsByPath = new Map();
  let oldPath = null;
  let currentLines = null;
  let readingHeaders = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = null;
      currentLines = null;
      readingHeaders = true;
      continue;
    }
    if (readingHeaders && line.startsWith("--- ")) {
      oldPath = parseDiffHeaderPath(line.slice(4), "a/");
      continue;
    }
    if (readingHeaders && line.startsWith("+++ ")) {
      const newPath = parseDiffHeaderPath(line.slice(4), "b/");
      const reviewPath = newPath ?? oldPath;
      if (reviewPath === null) {
        throw new Error("Diff не содержит путь ни для старой, ни для новой версии файла.");
      }
      currentLines = anchorsByPath.get(reviewPath) ?? { LEFT: new Set(), RIGHT: new Set() };
      anchorsByPath.set(reviewPath, currentLines);
      readingHeaders = false;
      continue;
    }
    if (!line.startsWith("@@ ")) {
      continue;
    }
    if (currentLines === null) {
      throw new Error("Hunk diff встретился до заголовка файла.");
    }

    const hunk = collectDiffLines(line);
    for (const side of ["LEFT", "RIGHT"]) {
      for (const lineNumber of hunk[side]) {
        currentLines[side].add(lineNumber);
      }
    }
  }

  return anchorsByPath;
}

export function validateFindingAnchors(findings, diff) {
  const anchorsByPath = collectDiffAnchors(diff);

  for (const finding of findings) {
    if (!anchorsByPath.get(finding.path)?.[finding.side].has(finding.line)) {
      throw new Error(
        `Finding ${finding.path}:${finding.side}:${finding.line} не привязан к изменённой строке точного diff.`,
      );
    }
  }
}

export function reviewMarker(baseSha, headSha, reviewModel) {
  if (!SHA_PATTERN.test(baseSha) || !SHA_PATTERN.test(headSha)) {
    throw new Error("Base SHA и Head SHA должны быть полными commit SHA.");
  }
  if (!REVIEW_MODELS.has(reviewModel)) {
    throw new Error(
      "REVIEW_MODEL должен быть claude-sonnet-5, claude-opus-5 или gpt-5.3-codex-spark.",
    );
  }
  return `<!-- ${REVIEW_MODELS.get(reviewModel).marker}:${baseSha}:${headSha}:${reviewModel} -->`;
}

export function buildReviewPayload(review, baseSha, headSha, reviewModel) {
  const model = REVIEW_MODELS.get(reviewModel);
  reviewMarker(baseSha, headSha, reviewModel);
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const finding of review.findings) {
    counts[finding.priority] += 1;
  }

  const summary = review.findings.length === 0
    ? "Существенных проблем не найдено."
    : `Найдено замечаний: P0 — ${counts.P0}, P1 — ${counts.P1}, P2 — ${counts.P2}.`;

  return {
    commit_id: headSha,
    body: [
      reviewMarker(baseSha, headSha, reviewModel),
      `### Ревью ${model.reviewer}`,
      "",
      `**Модель:** ${model.displayName}, усилие \`xhigh\`.`,
      "",
      summary,
      "",
      `_Проверен commit \`${headSha}\`._`,
    ].join("\n"),
    event: "COMMENT",
    comments: review.findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: `[${finding.priority}] ${finding.title}\n\n${finding.body}`,
    })),
  };
}

export function buildStaleReviewBody(baseSha, headSha, reviewModel) {
  const model = REVIEW_MODELS.get(reviewModel);
  reviewMarker(baseSha, headSha, reviewModel);
  return [
    reviewMarker(baseSha, headSha, reviewModel),
    `### ⚠️ Ревью ${model.reviewer} устарело`,
    "",
    "Head PR изменился во время публикации. Не используйте замечания этого ревью для текущей версии кода.",
    "",
    `_Ревью относилось к commit \`${headSha}\`._`,
  ].join("\n");
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Не задана обязательная переменная ${name}.`);
  }
  return value;
}

function validateRequestContext({ repository, pullNumber, baseSha, headSha, reviewModel }) {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("GITHUB_REPOSITORY имеет недопустимый формат.");
  }
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) {
    throw new Error("PR_NUMBER должен быть положительным целым числом.");
  }
  reviewMarker(baseSha, headSha, reviewModel);
}

async function githubRequest(path, { method = "GET", body, token } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "abrikosov-group-organizational-ai-review",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `GitHub API вернул ${response.status}: ${responseText.slice(0, 1_000) || "пустой ответ"}`,
    );
  }

  return responseText ? JSON.parse(responseText) : null;
}

async function findExistingReview({ repository, pullNumber, marker, token }) {
  for (let page = 1; page <= 20; page += 1) {
    const reviews = await githubRequest(
      `/repos/${repository}/pulls/${pullNumber}/reviews?per_page=100&page=${page}`,
      { token },
    );

    const existing = reviews.find(
      (review) => review.user?.login === "github-actions[bot]" && review.body?.includes(marker),
    );
    if (existing) {
      return existing;
    }
    if (reviews.length < 100) {
      return null;
    }
  }

  throw new Error("Не удалось проверить идемпотентность: в PR больше 2000 ревью.");
}

function exactDiff() {
  const diffPath = requireEnvironment("DIFF_PATH");
  const diff = readFileSync(diffPath);
  if (diff.byteLength > MAX_DIFF_BYTES) {
    throw new Error("Точный diff превышает допустимый размер.");
  }
  return diff.toString("utf8");
}

async function currentPullRequest({ repository, pullNumber, token }) {
  return githubRequest(`/repos/${repository}/pulls/${pullNumber}`, { token });
}

function pullRequestMatches(pullRequest, baseSha, headSha) {
  return pullRequest?.base?.sha === baseSha && pullRequest?.head?.sha === headSha;
}

export async function reviewNeeded({ repository, pullNumber, baseSha, headSha, reviewModel, token }) {
  validateRequestContext({ repository, pullNumber, baseSha, headSha, reviewModel });

  const pullRequest = await currentPullRequest({ repository, pullNumber, token });
  if (!pullRequestMatches(pullRequest, baseSha, headSha)) {
    return false;
  }

  const marker = reviewMarker(baseSha, headSha, reviewModel);
  return (await findExistingReview({ repository, pullNumber, marker, token })) === null;
}

async function checkReviewNeededFromEnvironment() {
  const repository = requireEnvironment("GITHUB_REPOSITORY");
  const rawPullNumber = requireEnvironment("PR_NUMBER");
  if (!/^[1-9]\d*$/u.test(rawPullNumber)) {
    throw new Error("PR_NUMBER должен быть положительным целым числом.");
  }

  return reviewNeeded({
    repository,
    pullNumber: Number.parseInt(rawPullNumber, 10),
    baseSha: requireEnvironment("BASE_SHA"),
    headSha: requireEnvironment("HEAD_SHA"),
    reviewModel: requireEnvironment("REVIEW_MODEL"),
    token: requireEnvironment("GH_TOKEN"),
  });
}

export async function main() {
  const repository = requireEnvironment("GITHUB_REPOSITORY");
  const rawPullNumber = requireEnvironment("PR_NUMBER");
  const pullNumber = Number.parseInt(rawPullNumber, 10);
  const baseSha = requireEnvironment("BASE_SHA");
  const headSha = requireEnvironment("HEAD_SHA");
  const token = requireEnvironment("GH_TOKEN");
  const reviewModel = requireEnvironment("REVIEW_MODEL");
  const rawReview = process.env.REVIEW_JSON_FILE
    ? readFileSync(process.env.REVIEW_JSON_FILE, "utf8")
    : requireEnvironment("REVIEW_JSON");
  const review = validateReviewJson(rawReview);

  if (!/^[1-9]\d*$/u.test(rawPullNumber)) {
    throw new Error("PR_NUMBER должен быть положительным целым числом.");
  }
  validateRequestContext({ repository, pullNumber, baseSha, headSha, reviewModel });

  const marker = reviewMarker(baseSha, headSha, reviewModel);
  const initialPullRequest = await currentPullRequest({ repository, pullNumber, token });
  if (!pullRequestMatches(initialPullRequest, baseSha, headSha)) {
    console.log("Base или Head PR уже изменился; устаревшее ревью не опубликовано.");
    return;
  }

  const existingReview = await findExistingReview({ repository, pullNumber, marker, token });
  if (existingReview) {
    console.log(`Ревью этого diff уже опубликовано: ${existingReview.html_url}`);
    return;
  }

  if (review.findings.length > 0) {
    validateFindingAnchors(review.findings, exactDiff());
  }

  const latestPullRequest = await currentPullRequest({ repository, pullNumber, token });
  if (!pullRequestMatches(latestPullRequest, baseSha, headSha)) {
    console.log("Base или Head PR изменился во время проверки; устаревшее ревью не опубликовано.");
    return;
  }

  const result = await githubRequest(`/repos/${repository}/pulls/${pullNumber}/reviews`, {
    method: "POST",
    body: buildReviewPayload(review, baseSha, headSha, reviewModel),
    token,
  });

  const finalPullRequest = await currentPullRequest({ repository, pullNumber, token });
  if (!pullRequestMatches(finalPullRequest, baseSha, headSha)) {
    if (!Number.isSafeInteger(result?.id) || result.id < 1) {
      throw new Error("GitHub не вернул ID опубликованного ревью; его нельзя пометить устаревшим.");
    }
    await githubRequest(`/repos/${repository}/pulls/${pullNumber}/reviews/${result.id}`, {
      method: "PUT",
      body: { body: buildStaleReviewBody(baseSha, headSha, reviewModel) },
      token,
    });
    console.log(`Ревью ${result.html_url} помечено устаревшим после изменения Head SHA.`);
    return;
  }

  console.log(`Атомарное ревью опубликовано: ${result.html_url}`);
}

const isEntrypoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntrypoint) {
  const entrypoint = process.argv.length === 3 && process.argv[2] === "--check-needed"
    ? async () => process.stdout.write(`${await checkReviewNeededFromEnvironment()}\n`)
    : process.argv.length === 2
      ? main
      : async () => {
          throw new Error("Поддерживается только необязательный аргумент --check-needed.");
        };

  entrypoint().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
