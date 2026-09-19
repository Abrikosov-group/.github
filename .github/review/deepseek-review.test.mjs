import { keychainCredential } from "./deepseek-keychain.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completion, PROFILE, ReviewFailure } from "./deepseek-client.mjs";
import { openSnapshot, sha256 } from "./deepseek-snapshot.mjs";
import { runReview } from "./run-deepseek-review.mjs";
import { verifyEvidence } from "./publish-deepseek-review.mjs";
import { buildReviewPayload, reviewMarker, validateReviewJson } from "./publish-claude-review.mjs";

const key = `sk-${"x".repeat(32)}`; // Synthetic credential, never a real key.
const base = "a".repeat(40), head = "b".repeat(40);
const response = (overrides = {}) => ({ model: PROFILE.model, id: "synthetic-response",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"findings":[]}', reasoning_content: "private reasoning" } }], ...overrides });
const complete = async (args) => completion({ ...args, fetchImpl: async () => Response.json(response()) });

function fixture(t, kind = "c3") {
  const root = mkdtempSync(join(tmpdir(), "deepseek-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input"); mkdirSync(input);
  const files = kind === "c3" ? {
    "prompt.txt": "Исходное независимое задание и текстовый diff.", "review.schema.json": '{"type":"object"}',
    "pull-request.diff": "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
    "binary-manifest.json": JSON.stringify({ schemaVersion: 2, baseSha: base, headSha: head, mergeBaseSha: base, binaryManifestSha256: sha256("[]"), files: [] }),
  } : { "review-task.md": "Проверь ТЗ и исходники.", "spec.md": "Требование: первая строка\nвторая строка", "source.txt": "Проверяемый соседний код" };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(input, path), content);
  const manifest = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha256(content)]));
  const manifestPath = join(root, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, input, output: join(root, "output"), kind, manifestPath, manifest, getKey: async () => key, complete };
}

test("provider request fixes Flash/max, rejects redirects and records only safe telemetry", async () => {
  let request;
  const value = await completion({ key, messages: [{ role: "user", content: "Исходное задание" }], json: true,
    fetchImpl: async (url, options) => { request = { url, ...options }; return Response.json(response()); } });
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.equal(request.redirect, "error");
  const body = JSON.parse(request.body);
  assert.equal(body.model, "deepseek-flash"); assert.equal(body.reasoning_effort, "max");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.tools, undefined);
  assert.equal(value.evidence.effortEcho, null);
  assert.equal(value.evidence.reasoningPresent, true);
  assert.doesNotMatch(JSON.stringify(value.evidence), /private reasoning|sk-/u);
});

for (const [name, fetchImpl, expected] of [
  ["401", async () => new Response(`secret ${key}`, { status: 401 }), "provider_http_401"],
  ["429", async () => new Response(key, { status: 429 }), "provider_http_429"],
  ["network", async () => { throw new Error(key); }, "transport_unavailable"],
  ["model", async () => Response.json(response({ model: "deepseek-v4-pro" })), "returned_model_mismatch"],
  ["truncated", async () => Response.json(response({ choices: [{ finish_reason: "length", message: {} }] })), "response_incomplete"],
  ["non-json", async () => new Response(key.slice(0, 5)), "response_invalid_json"],
  ["credential", async () => new Response(key), "credential_in_response"],
  ["oversize", async () => new Response("x".repeat(2 * 1024 * 1024 + 1)), "response_too_large"],
]) {
  test(`provider ${name}: one call, safe explicit failure, no retry or fallback`, async () => {
    let calls = 0;
    await assert.rejects(completion({ key, messages: [], fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } }),
      (error) => error.code === expected && !error.message.includes(key));
    assert.equal(calls, 1);
  });
}

test("aborted request and credential in input are explicit failures", async () => {
  await assert.rejects(completion({ key, messages: [{ content: key }] }), /credential_in_input/u);
  await assert.rejects(completion({ key, messages: [], signal: AbortSignal.abort(), fetchImpl: async () => { throw Error(); } }), /deadline_exceeded/u);
});

test("snapshot denies traversal, unlisted paths, symlinks, mutated files and unknown tools", (t) => {
  const f = fixture(t, "c2"), snapshot = openSnapshot(f.input, f.manifest);
  for (const path of ["../manifest.json", "/etc/passwd", "absent.md"]) assert.throws(() => snapshot.bytes(path));
  assert.throws(() => snapshot.execute("exec", { command: "ls" }), /tool_not_allowed/u);
  writeFileSync(join(f.input, "spec.md"), "changed");
  assert.throws(() => snapshot.verify(), /snapshot_invalid_or_changed/u);
  symlinkSync(f.manifestPath, join(f.input, "alias"));
  assert.throws(() => openSnapshot(f.input, { alias: sha256(readFileSync(f.manifestPath)) }));
});

test("snapshot file pagination and literal search report limits explicitly", (t) => {
  const f = fixture(t, "c2"), snapshot = openSnapshot(f.input, f.manifest);
  assert.deepEqual(JSON.parse(snapshot.execute("list_files", { prefix: "spec", offset: 0 })).paths, ["spec.md"]);
  assert.deepEqual(JSON.parse(snapshot.execute("read_file", { path: "spec.md", start_line: 2, line_count: 1 })).lines, ["2: вторая строка"]);
  const matches = JSON.parse(snapshot.execute("search_text", { prefix: "", text: "соседний" }));
  assert.equal(matches.matches[0].path, "source.txt"); assert.equal(matches.truncated, false);
  assert.throws(() => snapshot.execute("read_file", { path: "spec.md", start_line: 0, line_count: 1 }));
});

test("C3 preserves original prompt and binds accepted report to snapshot/model/profile", async (t) => {
  const f = fixture(t); let messages;
  const result = await runReview({ ...f, complete: async (args) => { messages = args.messages; return complete(args); } });
  assert.equal(messages[1].content, readFileSync(join(f.input, "prompt.txt"), "utf8"));
  assert.equal(result.state, "completed"); assert.equal(result.calls.length, 1);
  verifyEvidence(f.input, f.output, base, head);
  assert.doesNotMatch(readFileSync(join(f.output, "result.json"), "utf8"), /private reasoning|sk-/u);
  writeFileSync(join(f.output, "review.json"), '{"findings":[1]}');
  assert.throws(() => verifyEvidence(f.input, f.output, base, head));
  await assert.rejects(runReview(f), /EEXIST/u);
});

test("C3 input snapshot mismatch stops before accessing credentials or API", async (t) => {
  const f = fixture(t); let credentials = 0;
  const result = await runReview({ ...f, env: { BASE_SHA: "c".repeat(40), HEAD_SHA: head }, getKey: async () => { credentials++; return key; } });
  assert.equal(result.state, "unavailable"); assert.equal(credentials, 0);
});

test("missing credential persists unavailable state with no successful review", async (t) => {
  const f = fixture(t);
  const result = await runReview({ ...f, getKey: async () => "" });
  assert.equal(result.failure, "credential_unavailable"); assert.equal(result.state, "unavailable");
  assert.throws(() => readFileSync(join(f.output, "review.json")));
});

test("C2 fresh read-only context preserves tool reasoning in memory but never in artifacts", async (t) => {
  const f = fixture(t, "c2"); let count = 0;
  const result = await runReview({ ...f, complete: async ({ messages, tools, json }) => {
    assert.equal(json, false); assert.equal(tools.length, 3);
    count++;
    if (count === 1) {
      assert.equal(messages.length, 2);
      return { message: { role: "assistant", reasoning_content: "private reasoning", tool_calls: [{ id: "read1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "spec.md", start_line: 1, line_count: 20 }) } }] }, finishReason: "tool_calls", evidence: { model: PROFILE.model } };
    }
    assert.equal(messages[2].reasoning_content, "private reasoning");
    assert.match(messages[3].content, /первая строка/u);
    return { message: { content: "НЕТ СУЩЕСТВЕННЫХ БЛОКЕРОВ. Проверены ТЗ и материалы; тесты не запускались." }, finishReason: "stop", evidence: { model: PROFILE.model } };
  } });
  assert.equal(result.state, "completed"); assert.equal(result.accesses[0].path, "spec.md");
  assert.doesNotMatch(readFileSync(join(f.output, "result.json"), "utf8"), /private reasoning/u);
});

test("snapshot changes during model request never produce an accepted report", async (t) => {
  const f = fixture(t);
  const result = await runReview({ ...f, complete: async (args) => { writeFileSync(join(f.input, "prompt.txt"), "modified"); return complete(args); } });
  assert.equal(result.state, "unavailable"); assert.equal(result.failure, "snapshot_invalid_or_changed");
});

for (const scenario of ["already_published", "closed", "changed_during_review", "postcheck_failed"]) {
  test(`GitHub ${scenario}: no stale publication or unnecessary model attempt`, async (t) => {
    const f = fixture(t); let generated = 0, credentials = 0, prReads = 0;
    const request = { state: "open", draft: false, base: { sha: base }, head: { sha: head } };
    t.mock.method(globalThis, "fetch", async (url) => {
      if (url.includes("/reviews?")) return Response.json([{ id: 1, user: { login: "github-actions[bot]" }, body:
        `${reviewMarker(base, head, PROFILE.model)}\n<!-- review-findings:P0=0;P1=0;P2=0 -->\n<!-- review-binary-coverage:sha256=${sha256("[]")};files=0 -->` }]);
      prReads++;
      if (scenario === "postcheck_failed" && generated) throw new Error("synthetic API error");
      return Response.json({ ...request,
        ...(scenario === "closed" ? { state: "closed" } : {}),
        ...(scenario === "changed_during_review" && generated ? { head: { sha: "c".repeat(40) } } : {}),
      });
    });
    const result = await runReview({ ...f, github: true,
      env: { GITHUB_REPOSITORY: "owner/repo", PR_NUMBER: "1", BASE_SHA: base, HEAD_SHA: head, GH_TOKEN: "synthetic-github-token", FORCE_REVIEW: scenario === "already_published" ? "false" : "true" },
      getKey: async () => { credentials++; return key; },
      complete: async (args) => { generated++; return complete(args); },
    });
    const expected = { already_published: "reused", closed: "snapshot_no_longer_current", changed_during_review: "snapshot_no_longer_current", postcheck_failed: "freshness_unconfirmed" };
    assert.equal(result.state, expected[scenario]);
    assert.equal(generated, ["already_published", "closed"].includes(scenario) ? 0 : 1);
    assert.equal(credentials, generated);
    assert.ok(prReads >= 1);
    if (generated) assert.deepEqual(JSON.parse(readFileSync(join(f.output, "review.json"))), { findings: [] });
  });
}

test("C2 tool loop has a finite attempt budget and never starts a second dialogue", async (t) => {
  const f = fixture(t, "c2"); let calls = 0;
  const result = await runReview({ ...f, complete: async () => {
    calls++;
    return { message: { role: "assistant", tool_calls: [{ id: `list-${calls}`, type: "function", function: { name: "list_files", arguments: '{"prefix":"","offset":0}' } }] }, finishReason: "tool_calls", evidence: { model: PROFILE.model } };
  } });
  assert.equal(calls, 48); assert.equal(result.failure, "tool_round_budget_exceeded");
});

test("DeepSeek uses a separate max-profile marker and honest displayed effort", () => {
  assert.match(reviewMarker(base, head, PROFILE.model), /deepseek-review-max-v1/u);
  const payload = buildReviewPayload({ findings: [] }, base, head, PROFILE.model);
  assert.match(payload.body, /запрошенное усилие `max`/u); assert.doesNotMatch(payload.body, /xhigh/u);
  assert.throws(() => validateReviewJson({ findings: [{ priority: "P1", path: "a.js", line: 1, side: "RIGHT", title: "Проверка секрета", body: `Утечка ключа ${key}` }] }), /секрет/u);
});


test("Keychain C2 uses one fixed noninteractive client call and keeps credentials out of args/env", () => {
  let calls = 0;
  const fakeStat = { isFile: () => true, isSymbolicLink: () => false, mode: 0o500, uid: 1000 };
  const options = { home: "/users/test", uid: 1000, inspect: () => fakeStat, realpath: x => x };
  const value = keychainCredential({ ...options, execute: (path, args, config) => {
    calls++; assert.match(path, /DeepSeekReviewCredential$/u); assert.deepEqual(args, []);
    assert.equal(config.timeout, 10000); assert.doesNotMatch(JSON.stringify(config), /sk-/u);
    return { status: 0, stdout: key };
  } });
  assert.equal(value, key); assert.equal(calls, 1);
  calls=0;
  assert.throws(() => keychainCredential({ ...options, execute: () => { calls++; return {status:1,stderr:key}; } }), error => error.code === "credential_unavailable" && !error.message.includes(key));
  assert.equal(calls,1);
  assert.throws(() => keychainCredential({ ...options, inspect: () => ({ ...fakeStat, mode: 0o755 }), execute: () => { throw Error("must not run"); } }));
});
