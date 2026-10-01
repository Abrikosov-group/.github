import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { summarizeFailure, inspectFailure } from "./claude-failure-diagnostic.mjs";

test("is_error:true is diagnosed before the missing structured output", () => {
  const value = summarizeFailure([{ type: "result", subtype: "success", is_error: true,
    result: "OAuth token expired", errors: [], structured_output: null }]);
  assert.equal(value.reason, "authentication");
  assert.equal(value.result_success, false);
  assert.equal(value.is_error, true);
});

test("known provider errors remain distinct", () => {
  for (const [message, reason] of [
    ["Claude Code 2.1.226 does not support this model; version 2.1.280 or newer is required", "client_version_unsupported"],
    ["rate_limit_error: 429", "rate_limit"], ["credit balance too low", "billing"],
    ["model is not available", "model_unavailable"], ["403 access denied", "permission"],
    ["invalid_request_error", "invalid_request"], ["overloaded_error", "provider_unavailable"],
    ["connection error", "network"], ["unrecognized failure", "unclassified_sdk_error"],
  ]) {
    assert.equal(summarizeFailure([{ type: "result", subtype: "error", errors: [message] }]).reason, reason);
  }
});

test("no raw error, prompt, code, token or personal data escapes", () => {
  const secret = "sk-secret reader@example.com PRIVATE_CODE";
  const value = summarizeFailure([
    { type: "assistant", message: { content: [{ type: "text", text: secret }] } },
    { type: "result", subtype: "success", is_error: true, result: secret,
      errors: [`401 ${secret}`], modelUsage: { [secret]: {} } },
  ]);
  const serialized = JSON.stringify(value);
  assert.equal(value.reason, "authentication");
  for (const part of secret.split(" ")) assert.ok(!serialized.includes(part));
});

test("API error message is available even without a result; normal assistant text is ignored", () => {
  assert.equal(summarizeFailure([{ type: "assistant", isApiErrorMessage: true,
    message: { content: [{ type: "text", text: "API Error: rate limit" }] } }]).reason, "rate_limit");
  assert.equal(summarizeFailure([{ type: "assistant",
    message: { content: [{ type: "text", text: "401" }] } }]).reason, "no_result");
});

test("successful response is not mistaken for authentication error", () => {
  const value = summarizeFailure([{ type: "result", subtype: "success", is_error: false,
    result: "Reviewed code handling 401", structured_output: { findings: [] } }]);
  assert.equal(value.reason, "structured_output_or_action_error");
  assert.equal(value.result_success, true);
});

test("recovered API error does not replace the final successful result", () => {
  const value = summarizeFailure([
    { type: "assistant", isApiErrorMessage: true,
      message: { content: [{ type: "text", text: "API Error: 429 rate limit" }] } },
    { type: "result", subtype: "success", is_error: false, result: "ok", structured_output: null },
  ]);
  assert.equal(value.reason, "structured_output_or_action_error");
  assert.equal(value.result_success, true);
});

test("malformed assistant content cannot hide a valid terminal error", () => {
  for (const content of [null, "401", {}, 7]) {
    const value = summarizeFailure([
      { type: "assistant", isApiErrorMessage: true, message: { content } },
      { type: "result", subtype: "success", is_error: true, result: "Not logged in" },
    ]);
    assert.equal(value.reason, "authentication");
  }
});

test("only exact regular SDK file is read; missing and malformed files produce a diagnostic", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-failure-test-")));
  const file = join(root, "claude-execution-output.json");
  try {
    assert.equal((await inspectFailure(root, "")).reason, "execution_path_missing_or_invalid");
    assert.equal((await inspectFailure(root, join(root, "other.json"))).reason, "execution_path_missing_or_invalid");
    assert.equal((await inspectFailure(root, file)).reason, "execution_file_missing_or_invalid");
    await writeFile(file, "invalid");
    assert.equal((await inspectFailure(root, file)).reason, "execution_file_missing_or_invalid");
    await writeFile(file, JSON.stringify([{ type: "result", subtype: "success", is_error: true, result: "Not logged in" }]));
    assert.equal((await inspectFailure(root, file)).reason, "authentication");
    await rm(file);
    await writeFile(join(root, "other.json"), "[]");
    await symlink(join(root, "other.json"), file);
    assert.equal((await inspectFailure(root, file)).reason, "execution_file_unsafe");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed Action saves diagnostic before cleanup without changing review status or publisher", () => {
  const workflow = readFileSync(".github/workflows/review-all.yml", "utf8");
  const action = workflow.indexOf("id: claude\n");
  const diagnostic = workflow.indexOf("name: Сохранить причину сбоя Claude");
  const upload = workflow.indexOf("name: Сохранить диагностику сбоя Claude в артефакт");
  const cleanup = workflow.indexOf("name: Удалить временный результат Claude с Runner");
  assert.ok(action < diagnostic && diagnostic < upload && upload < cleanup);
  const steps = workflow.slice(diagnostic, upload);
  assert.match(steps, /always\(\) && steps\.claude\.outcome == 'failure'/u);
  assert.match(steps, /_review_infra\/\.github\/review\/claude-failure-diagnostic\.mjs/u);
  assert.match(workflow.slice(upload, cleanup), /always\(\) && steps\.claude\.outcome == 'failure'/u);
  assert.match(workflow.slice(upload, cleanup), /diagnostic\/failure\.json/u);
  assert.match(workflow, /show_full_output: false/u);
  assert.match(workflow, /Фактическая модель Opus 5\.5 не подтверждена/u);
  assert.ok(!workflow.slice(action, cleanup).includes("continue-on-error:"));
});

test("Action uses a compatible pinned CLI verified before receiving OAuth credentials", () => {
  const workflow = readFileSync(".github/workflows/review-all.yml", "utf8");
  const preparation = workflow.indexOf("name: Подготовить закреплённый CLI Claude с поддержкой Opus 5.5");
  const action = workflow.indexOf("id: claude\n");
  assert.ok(preparation > 0 && preparation < action);
  const install = workflow.slice(preparation, action);
  assert.match(install, /2\.1\.286\/linux-x64\/claude/u);
  assert.match(install, /fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f/u);
  assert.ok(install.indexOf("sha256sum --check --status") < install.indexOf('chmod 700'));
  assert.match(install, /2\.1\.286 \(Claude Code\)/u);
  assert.ok(!install.includes("secrets."));
  assert.match(workflow.slice(action), /path_to_claude_code_executable:.*\/bin\/claude/u);
});

test("installer rejects corrupted download and old version before model execution", () => {
  const workflow = readFileSync(".github/workflows/review-all.yml", "utf8");
  const block = workflow.split("      - name: Подготовить закреплённый CLI Claude с поддержкой Opus 5.5")[1]
    .split("      - name: Выполнить изолированное review-only ревью")[0];
  const original = block.split("        run: |\n")[1].split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
  for (const [version, corrupt, expected] of [["2.1.286", false, 0], ["2.1.226", false, 1], ["2.1.286", true, 1]]) {
    const root = mkdtempSync(join(tmpdir(), "claude-install-test-"));
    try {
      mkdirSync(join(root, "mocks"));
      const binary = `#!/bin/sh\nprintf '%s\\n' '${version} (Claude Code)'\n`;
      const hash = createHash("sha256").update(binary).digest("hex");
      writeFileSync(join(root, "payload"), binary);
      writeFileSync(join(root, "mocks/curl"), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = "--output" ]; then cp "$MOCK_PAYLOAD" "$2"; exit 0; fi\nshift\ndone\nexit 1\n', { mode: 0o700 });
      // macOS sha256sum lacks GNU long options; still verify the real payload hash.
      writeFileSync(join(root, "mocks/sha256sum"), '#!/bin/sh\n[ "$*" = "--check --status" ] || exit 1\nexec shasum -a 256 -c > /dev/null\n', { mode: 0o700 });
      // The isolated test substitutes the synthetic binary's hash, not source files.
      const script = original.replace("fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f",
        corrupt ? "0".repeat(64) : hash);
      const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
        ...process.env, PATH: `${join(root, "mocks")}:${process.env.PATH}`,
        MOCK_PAYLOAD: join(root, "payload"), REVIEW_ROOT: join(root, "review"),
      } });
      assert.equal(result.status, expected, result.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
