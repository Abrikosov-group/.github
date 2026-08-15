import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  evaluateBinaryDisposition,
  parseDispositionComment,
  validateDisposition,
} from "./validate-binary-disposition.mjs";

const HEAD_SHA = "2".repeat(40);
const REPOSITORY = "Abrikosov-group/example";
const PR_AUTHOR = { login: "author", id: 101 };

function manifest(paths = ["assets/font.woff2", "docs/file.pdf"]) {
  const files = paths.map((path) => ({ oldPath: null, newPath: path }));
  return {
    schemaVersion: 1,
    baseSha: "1".repeat(40),
    mergeBaseSha: "1".repeat(40),
    headSha: HEAD_SHA,
    binaryManifestSha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files,
  };
}

function disposition(paths = ["assets/font.woff2", "docs/file.pdf"], decision = "manual-review") {
  return {
    schemaVersion: 1,
    headSha: HEAD_SHA,
    binaryManifestSha256: manifest().binaryManifestSha256,
    files: paths.map((path) => ({
      path,
      decision,
      justification: "Проверено вручную: формат открывается и соответствует ожидаемому результату.",
    })),
  };
}

function commentBody(value) {
  return `/binary-disposition\n${JSON.stringify(value)}`;
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchScenario({ comments, permissions = {}, run = null, headSha = HEAD_SHA }) {
  return async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    if (path === "/repos/Abrikosov-group/example/pulls/7") {
      return response({ head: { sha: headSha }, user: PR_AUTHOR });
    }
    if (path.startsWith("/repos/Abrikosov-group/example/issues/7/comments")) {
      return response(comments);
    }
    const permissionMatch = path.match(/\/collaborators\/([^/]+)\/permission$/u);
    if (permissionMatch) {
      const login = decodeURIComponent(permissionMatch[1]);
      return permissions[login]
        ? response({ permission: permissions[login] })
        : response({ message: "Not Found" }, 404);
    }
    if (path === "/repos/Abrikosov-group/example/actions/runs/55" && run) {
      return response(run);
    }
    return response({ message: `Unexpected ${path}` }, 500);
  };
}

test("парсер принимает только JSON сразу после команды", () => {
  assert.deepEqual(parseDispositionComment(commentBody(disposition())), disposition());
  assert.equal(parseDispositionComment("/review-all"), null);
  assert.throws(
    () => parseDispositionComment("/binary-disposition\n```json\n{}\n```"),
    /без Markdown fence/u,
  );
});

test("автор PR закрывает coverage без repository permission", async () => {
  const result = await evaluateBinaryDisposition({
    manifest: manifest(),
    repository: REPOSITORY,
    pullNumber: 7,
    token: "test",
    fetchImplementation: fetchScenario({
      comments: [{ id: 12, user: PR_AUTHOR, body: commentBody(disposition()), html_url: "comment-12" }],
    }),
  });
  assert.equal(result.coverageClosed, true);
  assert.equal(result.disposition.actorIsPrAuthor, true);
  assert.equal(result.disposition.actor.id, PR_AUTHOR.id);
});

test("live write принимает disposition независимо от event association", async () => {
  const writer = { login: "writer", id: 202 };
  const result = await evaluateBinaryDisposition({
    manifest: manifest(),
    repository: REPOSITORY,
    pullNumber: 7,
    token: "test",
    fetchImplementation: fetchScenario({
      comments: [{ id: 13, user: writer, body: commentBody(disposition()), html_url: "comment-13" }],
      permissions: { writer: "write" },
    }),
  });
  assert.equal(result.coverageClosed, true);
  assert.equal(result.disposition.livePermission, "write");
});

test("посторонний actor даёт C42.1", async () => {
  const outsider = { login: "outsider", id: 303 };
  const result = await evaluateBinaryDisposition({
    manifest: manifest(),
    repository: REPOSITORY,
    pullNumber: 7,
    token: "test",
    fetchImplementation: fetchScenario({
      comments: [{ id: 14, user: outsider, body: commentBody(disposition()), html_url: "comment-14" }],
    }),
  });
  assert.equal(result.coverageClosed, false);
  assert.equal(result.code, "C42.1");
  assert.match(result.summary, /live write/u);
});

test("accepted-risk разрешён только Etogerman с точным stable ID", () => {
  assert.throws(
    () => validateDisposition(disposition(undefined, "accepted-risk"), {
      manifest: manifest(),
      actor: { login: "writer", id: 202 },
      permission: "write",
      prAuthor: PR_AUTHOR,
    }),
    /только Etogerman/u,
  );
  const accepted = validateDisposition(disposition(undefined, "accepted-risk"), {
    manifest: manifest(),
    actor: { login: "Etogerman", id: 224131170 },
    permission: "admin",
    prAuthor: PR_AUTHOR,
  });
  assert.equal(accepted.files[0].decision, "accepted-risk");
});

test("неполный список, пустое обоснование и stale manifest отклоняются", () => {
  const context = {
    manifest: manifest(),
    actor: PR_AUTHOR,
    permission: "none",
    prAuthor: PR_AUTHOR,
  };
  assert.throws(() => validateDisposition(disposition(["assets/font.woff2"]), context), /неполный/u);
  const empty = disposition();
  empty.files[0].justification = "";
  assert.throws(() => validateDisposition(empty, context), /непустой результат/u);
  const stale = disposition();
  stale.headSha = "3".repeat(40);
  assert.throws(() => validateDisposition(stale, context), /exact Head/u);
});

test("automated-check принимает только успешный run exact Head того же репозитория", async () => {
  const value = disposition();
  value.files[0] = {
    ...value.files[0],
    decision: "automated-check",
    runUrl: "https://github.com/Abrikosov-group/example/actions/runs/55",
  };
  const result = await evaluateBinaryDisposition({
    manifest: manifest(),
    repository: REPOSITORY,
    pullNumber: 7,
    token: "test",
    fetchImplementation: fetchScenario({
      comments: [{ id: 15, user: PR_AUTHOR, body: commentBody(value), html_url: "comment-15" }],
      run: {
        head_sha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
        repository: { full_name: REPOSITORY },
      },
    }),
  });
  assert.equal(result.coverageClosed, true);
});

test("при нулевом manifest coverage закрывается без disposition", async () => {
  const result = await evaluateBinaryDisposition({
    manifest: manifest([]),
    repository: REPOSITORY,
    pullNumber: 7,
    token: "test",
    fetchImplementation: fetchScenario({ comments: [] }),
  });
  assert.equal(result.coverageClosed, true);
  assert.match(result.summary, /нет/u);
});
