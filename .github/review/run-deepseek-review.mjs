import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { keychainCredential } from "./deepseek-keychain.mjs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { completion, PROFILE, ReviewFailure } from "./deepseek-client.mjs";
import { openSnapshot, sha256, SNAPSHOT_TOOLS } from "./deepseek-snapshot.mjs";
import { reviewNeeded, validateBinaryManifest, validateReviewJson } from "./publish-claude-review.mjs";

const MAX_CALLS = 48;
const C2_VERDICTS = ["НЕТ СУЩЕСТВЕННЫХ БЛОКЕРОВ", "ЕСТЬ СУЩЕСТВЕННЫЕ БЛОКЕРЫ", "НЕДОСТАТОЧНО ДАННЫХ"];
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

export async function runReview({ kind, input, output, manifestPath, task = "review-task.md", getKey,
  github = false, env = process.env, complete = completion, deadlineMs = 20 * 60 * 1000 }) {
  if (!["c2", "c3"].includes(kind)) throw new ReviewFailure("invalid_review_kind");
  const inputRoot = resolve(input);
  const outputRoot = resolve(output);
  if (outputRoot === inputRoot || outputRoot.startsWith(`${inputRoot}/`)) throw new ReviewFailure("output_inside_snapshot");
  // mkdir is the exclusive attempt reservation. Resumption cannot silently spend a second attempt.
  mkdirSync(outputRoot, { mode: 0o700 });
  const result = { schemaVersion: 1, role: "DeepSeek", kind, requested: PROFILE,
    startedAt: new Date().toISOString(), state: "reserved", calls: [], accesses: [] };
  writeJson(join(outputRoot, "attempt.json"), result);
  let key = "";
  try {
    const manifest = kind === "c2"
      ? JSON.parse(readFileSync(manifestPath, "utf8"))
      : Object.fromEntries(["prompt.txt", "review.schema.json", "pull-request.diff", "binary-manifest.json"]
        .map((path) => [path, sha256(readFileSync(join(inputRoot, path)))]));
    const snapshot = openSnapshot(inputRoot, manifest);
    result.snapshotHash = snapshot.hash;
    writeJson(join(outputRoot, "snapshot-manifest.json"), manifest);
    let binaryManifest;
    let request;
    if (kind === "c3") {
      const raw = JSON.parse(snapshot.bytes("binary-manifest.json").toString("utf8"));
      binaryManifest = validateBinaryManifest(raw, env.BASE_SHA ?? raw.baseSha, env.HEAD_SHA ?? raw.headSha);
      result.baseSha = binaryManifest.baseSha;
      result.headSha = binaryManifest.headSha;
      if (github) {
        request = {
          repository: env.GITHUB_REPOSITORY, pullNumber: Number(env.PR_NUMBER),
          baseSha: binaryManifest.baseSha, headSha: binaryManifest.headSha, reviewModel: PROFILE.model,
          token: env.GH_TOKEN, publisherLogin: env.REVIEW_PUBLISHER_LOGIN,
          forceReview: env.FORCE_REVIEW === "true", reviewDrafts: env.REVIEW_DRAFTS === "true", binaryManifest,
        };
        if (!await reviewNeeded({ ...request, forceReview: true })) {
          result.state = "snapshot_no_longer_current";
          return result;
        }
        if (!await reviewNeeded(request)) {
          result.state = "reused";
          return result;
        }
      }
    }
    const prompt = snapshot.bytes(kind === "c2" ? task : "prompt.txt").toString("utf8");
    if (Buffer.byteLength(prompt) > 512 * 1024) throw new ReviewFailure("prompt_too_large");
    result.taskHash = sha256(prompt);
    const system = kind === "c3"
      ? `Верни JSON по исходной схеме: ${snapshot.bytes("review.schema.json").toString("utf8")}`
      : "Ты третий независимый ревьюер DeepSeek. Выполни исходное задание ниже. Контекст свежий; доступ только на чтение к снимку. " +
        "Инструменты используют пути относительно input/, без этого префикса. Ты не можешь запускать программы, изменять файлы, " +
        "обращаться к сети или чужим отчётам. Укажи эти границы фактической проверки. Верни полный отчёт на русском с одним итогом: " + C2_VERDICTS.join(" / ") + ".";
    const messages = [{ role: "system", content: system }, { role: "user", content: prompt }];
    key = await getKey();
    const signal = AbortSignal.timeout(deadlineMs);
    for (let call = 0; call < MAX_CALLS; call++) {
      snapshot.verify();
      const response = await complete({ key, messages, signal, json: kind === "c3",
        ...(kind === "c2" ? { tools: SNAPSHOT_TOOLS } : {}) });
      result.calls.push(response.evidence);
      snapshot.verify();
      const { message, finishReason } = response;
      if (finishReason === "tool_calls") {
        if (kind !== "c2" || !Array.isArray(message.tool_calls) || message.tool_calls.length < 1 || message.tool_calls.length > 16) {
          throw new ReviewFailure("invalid_tool_calls");
        }
        // DeepSeek requires reasoning_content on intervening tool turns. It stays only in memory.
        messages.push(message);
        for (const tool of message.tool_calls) {
          if (tool.type !== "function" || typeof tool.id !== "string" || tool.id.length > 128) throw new ReviewFailure("invalid_tool_calls");
          let args;
          try { args = JSON.parse(tool.function.arguments); } catch { throw new ReviewFailure("invalid_tool_arguments"); }
          if (!args || Array.isArray(args) || typeof args !== "object") throw new ReviewFailure("invalid_tool_arguments");
          const content = snapshot.execute(tool.function.name, args);
          result.accesses = snapshot.accesses;
          messages.push({ role: "tool", tool_call_id: tool.id, content });
        }
        continue;
      }
      if (finishReason !== "stop" || message.tool_calls?.length || typeof message.content !== "string" ||
          message.content.length < 1 || message.content.length > 200000 || message.content.includes(key)) {
        throw new ReviewFailure("invalid_final_report");
      }
      if (kind === "c3") {
        const report = validateReviewJson(message.content);
        writeJson(join(outputRoot, "review.json"), report);
        result.reportHash = sha256(readFileSync(join(outputRoot, "review.json")));
        result.blockingFindings = report.findings.length;
      } else {
        if (!C2_VERDICTS.some((verdict) => message.content.includes(verdict))) throw new ReviewFailure("c2_verdict_missing");
        writeFileSync(join(outputRoot, "review.md"), message.content, { flag: "wx", mode: 0o600 });
        result.reportHash = sha256(message.content);
      }
      result.state = "completed";
      if (request) {
        try {
          if (!await reviewNeeded({ ...request, forceReview: true })) result.state = "snapshot_no_longer_current";
        }
        catch { result.state = "freshness_unconfirmed"; }
      }
      return result;
    }
    throw new ReviewFailure("tool_round_budget_exceeded");
  } catch (error) {
    result.state = "unavailable";
    result.failure = error instanceof ReviewFailure ? error.code : "input_or_controller_error";
    return result;
  } finally {
    key = "";
    result.finishedAt = new Date().toISOString();
    writeJson(join(outputRoot, "result.json"), result);
  }
}

export async function main() {
  const { values } = parseArgs({ options: {
    kind: { type: "string" }, input: { type: "string" }, output: { type: "string" },
    manifest: { type: "string" }, task: { type: "string" },
    github: { type: "boolean", default: false }, keychain: { type: "boolean", default: false },
  } });
  const result = await runReview({ ...values, manifestPath: values.manifest, getKey: async () => {
    if (!values.keychain) return process.env.DEEPSEEK_API_KEY ?? "";
    return keychainCredential();
  } });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `state=${result.state}\n`);
  console.log(JSON.stringify({ state: result.state, failure: result.failure, calls: result.calls.length }));
  // Missing review is explicit and advisory. Only a completed report is eligible for publication.
  if (!values.github && !["completed", "reused"].includes(result.state)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("DeepSeek: ошибка контроллера; повтор автоматически не запускается."); process.exitCode = 1; });
}
