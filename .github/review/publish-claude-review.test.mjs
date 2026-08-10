import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildReviewPayload,
  buildStaleReviewBody,
  collectDiffAnchors,
  collectDiffLines,
  main,
  reviewNeeded,
  reviewMarker,
  validateFindingAnchors,
  validateReviewJson,
} from "./publish-claude-review.mjs";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const STANDARD_MODEL = "claude-sonnet-5";
const DEEP_MODEL = "claude-opus-5";
const SPARK_MODEL = "gpt-5.3-codex-spark";

function fileDiff({ oldPath = "src/example.ts", newPath = "src/example.ts", hunk }) {
  return [
    `diff --git a/${oldPath} b/${newPath}`,
    `--- ${oldPath === "/dev/null" ? oldPath : `a/${oldPath}`}`,
    `+++ ${newPath === "/dev/null" ? newPath : `b/${newPath}`}`,
    hunk,
  ].join("\n");
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runMainWithFetch(fetchImplementation, environmentOverrides = {}) {
  const environment = {
    GITHUB_REPOSITORY: "example/sawabook",
    PR_NUMBER: "55",
    BASE_SHA,
    HEAD_SHA,
    GH_TOKEN: "test-token-without-production-access",
    REVIEW_MODEL: STANDARD_MODEL,
    REVIEW_JSON: JSON.stringify({ findings: [] }),
    ...environmentOverrides,
  };
  const previousEnvironment = new Map(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;

  Object.assign(process.env, environment);
  globalThis.fetch = fetchImplementation;
  console.log = () => {};

  try {
    await main();
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withFetch(fetchImplementation, callback) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImplementation;
  try {
    return await callback();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function validReview() {
  return {
    findings: [
      {
        priority: "P1",
        path: "src/example.ts",
        line: 12,
        side: "RIGHT",
        title: "Проверка пропускает ошибку",
        body: "При отрицательном значении запрос завершается с неверным результатом.",
      },
    ],
  };
}

test("валидирует строгий результат Claude", () => {
  assert.deepEqual(validateReviewJson(JSON.stringify(validReview())), validReview());
});

test("отклоняет неизвестные поля и обход пути", () => {
  assert.throws(
    () => validateReviewJson({ ...validReview(), summary: "лишнее" }),
    /неожиданные поля/u,
  );

  const review = validReview();
  review.findings[0].path = "../secret";
  assert.throws(() => validateReviewJson(review), /Недопустимый путь/u);
});

test("отклоняет дубли одной строки и похожие на секреты строки", () => {
  const duplicate = validReview();
  duplicate.findings.push({ ...duplicate.findings[0], priority: "P2" });
  assert.throws(() => validateReviewJson(duplicate), /только одно/u);

  const leakedSecret = validReview();
  leakedSecret.findings[0].body = `Утечка sk-ant-${"a".repeat(24)}`;
  assert.throws(() => validateReviewJson(leakedSecret), /похоже на секрет/u);

  const telegramToken = validReview();
  telegramToken.findings[0].body = `Утечка 123456789:AA${"b".repeat(33)}`;
  assert.throws(() => validateReviewJson(telegramToken), /персональные данные/u);

  const personalEmail = validReview();
  personalEmail.findings[0].body = "В ошибку попадает адрес real.person@example.com пользователя.";
  assert.throws(() => validateReviewJson(personalEmail), /персональные данные/u);

  const telegramId = validReview();
  telegramId.findings[0].body = "В ошибку попадает Telegram ID 123456789 пользователя.";
  assert.throws(() => validateReviewJson(telegramId), /персональные данные/u);

  const paymentPayload = validReview();
  paymentPayload.findings[0].body = "В ошибку попадает payment_payload=private-order-12345.";
  assert.throws(() => validateReviewJson(paymentPayload), /персональные данные/u);
});

test("принимает обычные OAuth-идентификаторы", () => {
  const review = validReview();
  review.findings[0].path = "src/oauth_callback_handler.ts";
  review.findings[0].body = "Функция `oauth_callback_handler` пропускает обязательную проверку состояния.";

  assert.deepEqual(validateReviewJson(review), review);
});

test("отклоняет англоязычные заголовок и описание finding", () => {
  const englishTitle = validReview();
  englishTitle.findings[0].title = "Validation accepts an invalid value";
  assert.throws(() => validateReviewJson(englishTitle), /русский текст/u);

  const englishBody = validReview();
  englishBody.findings[0].body = "The request returns an invalid result for a negative value.";
  assert.throws(() => validateReviewJson(englishBody), /русский текст/u);

  const disguisedEnglish = validReview();
  disguisedEnglish.findings[0].body = "Ошибка: validation accepts an invalid request and returns the wrong result.";
  assert.throws(() => validateReviewJson(disguisedEnglish), /русский текст/u);
});

test("извлекает строки обеих сторон из zero-context diff", () => {
  const diff = [
    "@@ -4,2 +4,3 @@",
    "-old",
    "+new",
    "+newer",
    "+newest",
    "@@ -20,0 +25,2 @@",
    "+one",
    "+two",
    "@@ -40,2 +44,0 @@",
    "-deleted",
  ].join("\n");

  const lines = collectDiffLines(diff);
  assert.deepEqual([...lines.LEFT], [4, 5, 40, 41]);
  assert.deepEqual([...lines.RIGHT], [4, 5, 6, 25, 26]);
});

test("принимает finding только на изменённой стороне точного diff", () => {
  const review = validateReviewJson(validReview());
  validateFindingAnchors(
    review.findings,
    fileDiff({ hunk: "@@ -8,0 +12,1 @@\n+added" }),
  );

  review.findings[0].line = 13;
  assert.throws(
    () => validateFindingAnchors(
      review.findings,
      fileDiff({ hunk: "@@ -8,0 +12,1 @@\n+added" }),
    ),
    /не привязан/u,
  );

  review.findings[0].line = 8;
  review.findings[0].side = "LEFT";
  validateFindingAnchors(
    review.findings,
    fileDiff({ hunk: "@@ -8,1 +12,1 @@\n-old\n+added" }),
  );
});

test("сохраняет LEFT и RIGHT anchors при rename", () => {
  const diff = fileDiff({
    oldPath: "src/old-name.ts",
    newPath: "src/new-name.ts",
    hunk: "@@ -10,2 +10,2 @@\n-old\n-deleted\n+new\n+added",
  });
  const anchors = collectDiffAnchors(diff);

  assert.deepEqual([...anchors.get("src/new-name.ts").LEFT], [10, 11]);
  assert.deepEqual([...anchors.get("src/new-name.ts").RIGHT], [10, 11]);
  assert.equal(anchors.has("src/old-name.ts"), false);

  const renamedFinding = validReview().findings[0];
  renamedFinding.path = "src/new-name.ts";
  renamedFinding.line = 10;
  renamedFinding.side = "LEFT";
  validateFindingAnchors([renamedFinding], diff);
});

test("создаёт одно review с итогом и inline comments", () => {
  const review = validateReviewJson(validReview());
  const payload = buildReviewPayload(review, BASE_SHA, HEAD_SHA, STANDARD_MODEL);

  assert.equal(payload.event, "COMMENT");
  assert.equal(payload.commit_id, HEAD_SHA);
  assert.match(payload.body, /P0 — 0, P1 — 1, P2 — 0/u);
  assert.ok(payload.body.startsWith(reviewMarker(BASE_SHA, HEAD_SHA, STANDARD_MODEL)));
  assert.match(payload.body, /Claude Sonnet 5, усилие `xhigh`/u);
  assert.deepEqual(payload.comments, [
    {
      path: "src/example.ts",
      line: 12,
      side: "RIGHT",
      body: "[P1] Проверка пропускает ошибку\n\nПри отрицательном значении запрос завершается с неверным результатом.",
    },
  ]);
});

test("создаёт итог без inline comments при пустом результате", () => {
  const payload = buildReviewPayload({ findings: [] }, BASE_SHA, HEAD_SHA, STANDARD_MODEL);
  assert.deepEqual(payload.comments, []);
  assert.match(payload.body, /Существенных проблем не найдено\./u);
});

test("различает обычное и углублённое ревью одного diff", () => {
  const standardMarker = reviewMarker(BASE_SHA, HEAD_SHA, STANDARD_MODEL);
  const deepMarker = reviewMarker(BASE_SHA, HEAD_SHA, DEEP_MODEL);
  const deepPayload = buildReviewPayload({ findings: [] }, BASE_SHA, HEAD_SHA, DEEP_MODEL);

  assert.notEqual(standardMarker, deepMarker);
  assert.match(deepPayload.body, /Claude Opus 5, усилие `xhigh`/u);
  assert.throws(
    () => reviewMarker(BASE_SHA, HEAD_SHA, "claude-unknown-5"),
    /REVIEW_MODEL/u,
  );
});

test("создаёт отдельное русское ревью GPT-5.3-Codex-Spark", () => {
  const marker = reviewMarker(BASE_SHA, HEAD_SHA, SPARK_MODEL);
  const payload = buildReviewPayload({ findings: [] }, BASE_SHA, HEAD_SHA, SPARK_MODEL);

  assert.match(marker, /^<!-- codex-review:/u);
  assert.ok(payload.body.startsWith(marker));
  assert.match(payload.body, /### Ревью Codex/u);
  assert.match(payload.body, /GPT-5\.3-Codex-Spark, усилие `xhigh`/u);
  assert.notEqual(marker, reviewMarker(BASE_SHA, HEAD_SHA, STANDARD_MODEL));
});

test("читает структурированный результат Codex из доверенного файла", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "organizational-review-json-"));
  const reviewPath = join(temporaryDirectory, "review.json");
  writeFileSync(reviewPath, JSON.stringify({ findings: [] }));
  const calls = [];
  const currentPullRequest = { base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } };

  try {
    await runMainWithFetch(async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1 || calls.length === 3 || calls.length === 5) {
        return jsonResponse(currentPullRequest);
      }
      if (calls.length === 2) {
        return jsonResponse([]);
      }
      return jsonResponse({
        id: 46,
        html_url: "https://github.com/example/sawabook/pull/55#spark-review",
      });
    }, {
      REVIEW_MODEL: SPARK_MODEL,
      REVIEW_JSON: "",
      REVIEW_JSON_FILE: reviewPath,
    });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const payload = JSON.parse(calls[3].options.body);
  assert.match(payload.body, /GPT-5\.3-Codex-Spark/u);
});

test("до запуска Claude пропускает дубликат и устаревшее событие", async () => {
  const context = {
    repository: "example/sawabook",
    pullNumber: 55,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    reviewModel: STANDARD_MODEL,
    token: "test-token-without-production-access",
  };
  const currentPullRequest = { base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } };
  const marker = reviewMarker(BASE_SHA, HEAD_SHA, STANDARD_MODEL);

  const duplicateCalls = [];
  const duplicateNeeded = await withFetch(async (url) => {
    duplicateCalls.push(String(url));
    if (duplicateCalls.length === 1) {
      return jsonResponse(currentPullRequest);
    }
    return jsonResponse([{ user: { login: "github-actions[bot]" }, body: marker }]);
  }, () => reviewNeeded(context));
  assert.equal(duplicateNeeded, false);
  assert.equal(duplicateCalls.length, 2);

  const missingCalls = [];
  const missingNeeded = await withFetch(async (url) => {
    missingCalls.push(String(url));
    return missingCalls.length === 1 ? jsonResponse(currentPullRequest) : jsonResponse([]);
  }, () => reviewNeeded(context));
  assert.equal(missingNeeded, true);
  assert.equal(missingCalls.length, 2);

  const staleCalls = [];
  const staleNeeded = await withFetch(async (url) => {
    staleCalls.push(String(url));
    return jsonResponse({ base: { sha: BASE_SHA }, head: { sha: "3".repeat(40) } });
  }, () => reviewNeeded(context));
  assert.equal(staleNeeded, false);
  assert.equal(staleCalls.length, 1);
});

test("публикует итог и comments одним API-запросом после тройной проверки SHA", async () => {
  const calls = [];
  const currentPullRequest = { base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } };

  await runMainWithFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1 || calls.length === 3 || calls.length === 5) {
      return jsonResponse(currentPullRequest);
    }
    if (calls.length === 2) {
      return jsonResponse([]);
    }
    return jsonResponse({
      id: 42,
      html_url: "https://github.com/example/sawabook/pull/55#review",
    });
  });

  assert.equal(calls.length, 5);
  assert.equal(calls[3].options.method, "POST");
  assert.match(calls[3].url, /\/pulls\/55\/reviews$/u);
  const payload = JSON.parse(calls[3].options.body);
  assert.deepEqual(payload.comments, []);
  assert.ok(payload.body.startsWith(reviewMarker(BASE_SHA, HEAD_SHA, STANDARD_MODEL)));
});

test("проверяет inline comments по точному diff из доверенного файла", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "organizational-review-diff-"));
  const diffPath = join(temporaryDirectory, "pull-request.diff");
  writeFileSync(
    diffPath,
    fileDiff({ hunk: "@@ -8,0 +12,1 @@\n+added" }),
  );
  const calls = [];
  const currentPullRequest = { base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } };

  try {
    await runMainWithFetch(async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1 || calls.length === 3 || calls.length === 5) {
        return jsonResponse(currentPullRequest);
      }
      if (calls.length === 2) {
        return jsonResponse([]);
      }
      return jsonResponse({
        id: 45,
        html_url: "https://github.com/example/sawabook/pull/55#review-with-comment",
      });
    }, {
      REVIEW_JSON: JSON.stringify(validReview()),
      DIFF_PATH: diffPath,
    });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const payload = JSON.parse(calls[3].options.body);
  assert.equal(payload.comments.length, 1);
  assert.equal(payload.comments[0].line, 12);
});

test("не публикует повторное ревью того же diff", async () => {
  const calls = [];
  const marker = reviewMarker(BASE_SHA, HEAD_SHA, STANDARD_MODEL);

  await runMainWithFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return jsonResponse({ base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } });
    }
    return jsonResponse([
      {
        user: { login: "github-actions[bot]" },
        body: marker,
        html_url: "https://github.com/example/sawabook/pull/55#existing-review",
      },
    ]);
  });

  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.options.method === "POST"), false);
});

test("публикует Opus после Sonnet для того же diff", async () => {
  const calls = [];
  const currentPullRequest = { base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } };
  const standardMarker = reviewMarker(BASE_SHA, HEAD_SHA, STANDARD_MODEL);

  await runMainWithFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1 || calls.length === 3 || calls.length === 5) {
      return jsonResponse(currentPullRequest);
    }
    if (calls.length === 2) {
      return jsonResponse([
        {
          user: { login: "github-actions[bot]" },
          body: standardMarker,
          html_url: "https://github.com/example/sawabook/pull/55#standard-review",
        },
      ]);
    }
    return jsonResponse({
      id: 43,
      html_url: "https://github.com/example/sawabook/pull/55#deep-review",
    });
  }, { REVIEW_MODEL: DEEP_MODEL });

  assert.equal(calls.length, 5);
  const payload = JSON.parse(calls[3].options.body);
  assert.ok(payload.body.startsWith(reviewMarker(BASE_SHA, HEAD_SHA, DEEP_MODEL)));
  assert.match(payload.body, /Claude Opus 5/u);
});

test("[6] помечает опубликованное ревью устаревшим при гонке Head SHA", async () => {
  const calls = [];
  const currentPullRequest = { base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } };
  const changedPullRequest = { base: { sha: BASE_SHA }, head: { sha: "3".repeat(40) } };

  await runMainWithFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1 || calls.length === 3) {
      return jsonResponse(currentPullRequest);
    }
    if (calls.length === 2) {
      return jsonResponse([]);
    }
    if (calls.length === 4) {
      return jsonResponse({
        id: 44,
        html_url: "https://github.com/example/sawabook/pull/55#stale-review",
      });
    }
    if (calls.length === 5) {
      return jsonResponse(changedPullRequest);
    }
    return jsonResponse({ id: 44, body: JSON.parse(options.body).body });
  });

  assert.equal(calls.length, 6);
  assert.equal(calls[5].options.method, "PUT");
  assert.match(calls[5].url, /\/pulls\/55\/reviews\/44$/u);
  const stalePayload = JSON.parse(calls[5].options.body);
  assert.equal(
    stalePayload.body,
    buildStaleReviewBody(BASE_SHA, HEAD_SHA, STANDARD_MODEL),
  );
  assert.match(stalePayload.body, /Ревью Claude устарело/u);
});

test("[5] не публикует результат для устаревшего Head SHA", async () => {
  const calls = [];

  await runMainWithFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ base: { sha: BASE_SHA }, head: { sha: "3".repeat(40) } });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls.some((call) => call.options.method === "POST"), false);
});
