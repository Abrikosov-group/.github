import { lstat, readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Only fixed diagnostic labels may leave the raw SDK log. Error text can contain
// credentials, repository contents or user data, so it is never copied verbatim.
const reasons = [
  ["client_version_unsupported", /Claude Code [\d.]+ does not support this model|version [\d.]+ or newer is required/iu],
  ["authentication", /not logged in|please run \/login|authentication_error|invalid api key|oauth.{0,40}(?:expired|invalid)|unauthorized|\b401\b/iu],
  ["rate_limit", /rate_limit_error|rate limit|hit your limit|usage limit|\b429\b/iu],
  ["billing", /credit balance|billing|payment required/iu],
  ["model_unavailable", /model.{0,60}(?:not found|not available|not supported|does not exist)|unknown model|not_found_error/iu],
  ["permission", /permission_error|access denied|not authorized|\b403\b/iu],
  ["invalid_request", /invalid_request_error|invalid (?:request|argument)|\b400\b/iu],
  ["provider_unavailable", /overloaded_error|overloaded|internal_server_error|\b50[02349]\b/iu],
  ["network", /connection error|fetch failed|econnreset|enotfound|etimedout|timed out/iu],
];

export function summarizeFailure(messages) {
  const result = Array.isArray(messages)
    ? messages.findLast((item) => item?.type === "result") : null;
  const failed = result && (result.is_error === true || result.subtype !== "success");
  const texts = failed ? [result.result, ...(Array.isArray(result.errors) ? result.errors : [])] : [];
  if (Array.isArray(messages)) {
    for (const item of messages) {
      if (item?.type !== "assistant" || item.isApiErrorMessage !== true) continue;
      for (const block of item.message?.content ?? []) {
        if (block?.type === "text") texts.push(block.text);
      }
    }
  }
  const errorText = texts.filter((text) => typeof text === "string")
    .map((text) => text.slice(0, 8192)).join("\n");
  return {
    version: 1,
    source: "sdk_execution",
    result_present: Boolean(result),
    result_success: Boolean(result?.subtype === "success" && result?.is_error === false),
    is_error: result?.is_error === true,
    structured_output_present: Boolean(result?.structured_output),
    reason: reasons.find(([, pattern]) => pattern.test(errorText))?.[0]
      ?? (failed ? "unclassified_sdk_error" : result ? "structured_output_or_action_error" : "no_result"),
  };
}

export async function inspectFailure(runnerTemp, executionFile) {
  const expected = join(resolve(runnerTemp), "claude-execution-output.json");
  if (!executionFile || resolve(executionFile) !== expected) {
    return { version: 1, source: "unavailable", reason: "execution_path_missing_or_invalid" };
  }
  try {
    const info = await lstat(expected);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024
        || await realpath(expected) !== expected) {
      return { version: 1, source: "unavailable", reason: "execution_file_unsafe" };
    }
    return summarizeFailure(JSON.parse(await readFile(expected, "utf8")));
  } catch {
    return { version: 1, source: "unavailable", reason: "execution_file_missing_or_invalid" };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.env.CLAUDE_DIAGNOSTIC_FILE;
  const diagnostic = await inspectFailure(process.env.RUNNER_TEMP, process.env.EXECUTION_FILE);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(diagnostic));
}
