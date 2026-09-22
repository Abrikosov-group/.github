import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PRIMARY_MODEL = "gpt-5.3-codex-spark";
export const FALLBACK_MODEL = "gpt-5.6-sol";
export const PROFILE_IDS = ["account-1", "account-2", "account-3"];
export const PROFILE_LOCK_BUSY_CODE = 75;
export const DEFAULT_PROFILE_WAIT_MS = 10 * 60_000;
export const DEFAULT_PROFILE_RETRY_MS = 1_000;
const MODELS = new Set([PRIMARY_MODEL, FALLBACK_MODEL]);
export const CODEX_SLOTS = [
  { slot: "account-1-spark", profileId: "account-1", model: PRIMARY_MODEL },
  { slot: "account-1-sol", profileId: "account-1", model: FALLBACK_MODEL },
  { slot: "account-2-spark", profileId: "account-2", model: PRIMARY_MODEL },
  { slot: "account-2-sol", profileId: "account-2", model: FALLBACK_MODEL },
  { slot: "account-3-spark", profileId: "account-3", model: PRIMARY_MODEL },
  { slot: "account-3-sol", profileId: "account-3", model: FALLBACK_MODEL },
];
const SHA = /^[a-f0-9]{40}$/u;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_RESULT = 128 * 1024;
const DIAGNOSTIC_CODES = new Set([
  "model_not_found", "model_not_available", "unsupported_model", "invalid_request_error",
  "invalid_api_key", "authentication_error", "unauthorized", "permission_denied",
  "insufficient_quota", "usage_limit_reached", "model_rate_limit_exceeded", "rate_limit_exceeded",
  "context_length_exceeded", "invalid_prompt", "invalid_schema", "server_error",
  "internal_server_error", "service_unavailable", "connection_reset", "connection_error",
]);
const LAUNCH_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "E2BIG"]);

function structuredErrors(events = "") {
  const errors = [];
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  for (const line of events.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!object(event) || !["error", "turn.failed"].includes(event.type)) continue;
    const error = object(event.error) ? event.error : event;
    errors.push({ ...error, status: error.status ?? event.status });
  }
  return errors;
}

// Only fixed categories/codes and bounded numbers leave the process. Provider
// messages, arbitrary error fields, stderr and model text never enter the audit.
export function attemptDiagnostic({ model, result, report }) {
  const error = structuredErrors(result.events).at(-1);
  const code = typeof error?.code === "string" ? error.code : error?.type;
  const message = typeof error?.message === "string" ? error.message : "";
  const description = `${typeof code === "string" ? code : ""} ${message}`;
  const validStatus = value => Number.isInteger(value) && value >= 400 && value <= 599;
  const textStatus = Number(message.match(/(?:unexpected status|HTTP(?: status)?)\s+(\d{3})\b/iu)?.[1]);
  const httpStatus = validStatus(error?.status) ? error.status : validStatus(textStatus) ? textStatus : null;
  const modelLimit = error?.scope === "model" && error.model === model
    && (httpStatus === 429 || code === "model_rate_limit_exceeded");
  let category;
  if (result.code === 0 && !result.signal && !result.timedOut && !result.overflow && report.valid) category = "accepted";
  else if (result.overflow) category = "output_limit";
  else if (result.timedOut) category = "timeout";
  else if (result.signal) category = "signal_termination";
  else if (report.present && !report.valid) category = "invalid_report";
  else if ([401, 403].includes(httpStatus) || /authentication|unauthori[sz]ed|invalid.api.key|permission.denied/iu.test(description)) category = "authentication";
  else if (/insufficient.quota|usage.limit|credit|billing/iu.test(description)
    || ((httpStatus === 429 || code === "rate_limit_exceeded") && !modelLimit)) category = "shared_quota";
  else if (modelLimit) category = "model_limit";
  else if (/context.{0,30}(window|length|limit)|input.{0,30}(large|invalid|limit)|invalid.{0,10}(schema|prompt)/iu.test(description)) category = "invalid_input";
  else if ((description.includes(model) && /not supported|not available|does not exist|model.not.found/iu.test(description))
    || ["model_not_found", "model_not_available", "unsupported_model"].includes(code)) category = "model_unavailable";
  else if (/server_error|internal_server_error|service_unavailable|connection_reset|connection_error/iu.test(description)
    || [500, 502, 503, 504].includes(httpStatus)) category = "provider_failure";
  else category = result.code === 0 ? "missing_report" : "process_failed";
  // A CLI argument/configuration failure may happen before JSON streaming starts.
  // Stderr can refine an otherwise unknown failure, never request a fallback.
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (!error && category === "process_failed") {
    if (/error:\s*(?:unexpected argument|invalid value|unrecognized (?:argument|option)|unknown (?:argument|option))|(?:failed|unable) to (?:load|parse) (?:the )?(?:configuration|config)|error parsing.{0,30}(?:config|overrides)/iu.test(stderr)) category = "cli_configuration";
    else if (/certificate verify failed|invalid peer certificate|certificate.{0,60}unknown issuer/iu.test(stderr)) category = "tls_failure";
  }
  return { category, httpStatus: category === "accepted" ? null : httpStatus,
    errorCode: category !== "accepted" && DIAGNOSTIC_CODES.has(code) ? code : null,
    timedOut: Boolean(result.timedOut), outputOverflow: Boolean(result.overflow),
    reportPresent: report.present, reportValid: report.valid, stderrPresent: stderr.length > 0 };
}

// Only structured CLI transport errors qualify. Model text, stderr echoes and
// invalid reports cannot request another model or a second review.
export function fallbackReason({ code, signal, events, reportPresent, timedOut, model = PRIMARY_MODEL }) {
  if (reportPresent || (signal && !timedOut) || (code === 0 && !timedOut)) return null;
  const errors = structuredErrors(events);
  const modelLimit = e => e.scope === "model" && e.model === model
    && (e.status === 429 || e.code === "model_rate_limit_exceeded");
  const sharedLimit = e => e.scope === "shared" || e.scope === "organization" || e.scope === "project"
    || e.code === "insufficient_quota";
  const accountLimit = e => !sharedLimit(e) &&
    (e.scope === "account" || e.code === "usage_limit_reached"
      || /account.{0,30}(quota|limit)|(?:quota|usage).{0,30}limit/iu.test(`${e.code ?? e.type ?? ""} ${e.message ?? ""}`)
      || (e.status === 429 && !modelLimit(e)));
  // Authentication and shared quota failures are not repaired by changing account.
  if (timedOut && errors.some(accountLimit)) return null;
  if (errors.some(e => /authentication|unauthori[sz]ed|invalid.api.key/iu.test(`${e.code ?? e.type ?? ""} ${e.message ?? ""}`)
    || [401, 403].includes(e.status)
    || (/insufficient.quota|usage.limit|credit|billing/iu.test(`${e.code ?? e.type ?? ""} ${e.message ?? ""}`) && !accountLimit(e)))) return null;
  // A transient error earlier in the stream does not override the terminal
  // error (for example, an invalid or oversized input after reconnection).
  const lastError = errors.at(-1);
  if (lastError && /context.{0,30}(window|length|limit)|input.{0,30}(large|invalid|limit)|invalid.{0,10}schema/iu.test(`${lastError.code ?? ""} ${lastError.message ?? ""}`)) return null;
  if (timedOut) return "primary_timeout";
  for (const e of lastError ? [lastError] : []) {
    const message = `${e.code ?? e.type ?? ""} ${e.message ?? ""}`;
    if (accountLimit(e)) return "account_limit";
    if (modelLimit(e)) return model === PRIMARY_MODEL ? "primary_model_limit" : "model_limit";
    if (message.includes(model) && /not supported|not available|does not exist|model.not.found/iu.test(message)) {
      return model === PRIMARY_MODEL ? "primary_model_unavailable" : "model_unavailable";
    }
    if (/server_error|internal_server_error|service_unavailable|connection_reset|connection_error/iu.test(message)
      || [500, 502, 503, 504].includes(e.status)) return "provider_technical_failure";
  }
  return null;
}

export function codexInvocation({ model, profileRoot, profileId, workDir, schemaPath, resultPath, env = process.env }) {
  if (!MODELS.has(model)) throw new Error("Недопустимая модель Codex.");
  const cleanEnv = {};
  for (const key of ["HOME", "PATH", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (env[key]) cleanEnv[key] = env[key];
  }
  cleanEnv.LANG = env.LANG || "C.UTF-8";
  const isolatedProfile = profileRoot && profileId ? join(resolve(profileRoot), profileId) : null;
  cleanEnv.CODEX_HOME = isolatedProfile
    ? join(isolatedProfile, ".codex")
    : env.CODEX_HOME || join(env.HOME, ".codex");
  cleanEnv.TMPDIR = env.RUNNER_TEMP;
  const args = ["exec", "--model", model, "-c", 'model_reasoning_effort="xhigh"',
    "-c", 'web_search="disabled"',
    "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules"];
  for (const feature of ["shell_tool", "apps", "plugins", "browser_use", "computer_use", "image_generation", "multi_agent", "skill_search"]) args.push("--disable", feature);
  if (model === FALLBACK_MODEL) args.push("-c", 'service_tier="default"');
  args.push("--color", "never", "--json", "--cd", workDir, "--output-schema", schemaPath, "--output-last-message", resultPath, "-");
  return { args, env: cleanEnv, lockPath: isolatedProfile ? join(isolatedProfile, ".lock") : null };
}

export async function executeCodex({ model, profileRoot, profileId, workDir, schemaPath, resultPath, prompt, signal,
  binary = "codex", timeoutMs = 20 * 60_000, env = process.env }) {
  const invocation = codexInvocation({ model, profileRoot, profileId, workDir, schemaPath, resultPath, env });
  const command = invocation.lockPath ? "flock" : binary;
  const commandArgs = invocation.lockPath
    ? ["--exclusive", "--nonblock", "--conflict-exit-code", String(PROFILE_LOCK_BUSY_CODE), invocation.lockPath, binary, ...invocation.args]
    : invocation.args;
  return new Promise((resolveResult, reject) => {
    if (signal.aborted) { reject(new Error("Запуск отменён.")); return; }
    const child = spawn(command, commandArgs, { env: invocation.env, cwd: workDir,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let events = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    let escalation;
    const kill = (kind) => {
      if (!child.pid) return;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, kind); } catch (e) { if (e.code !== "ESRCH") throw e; }
    };
    const terminate = () => {
      kill("SIGTERM");
      escalation ??= setTimeout(() => kill("SIGKILL"), 2_000);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const cancel = () => terminate();
    signal.addEventListener("abort", cancel, { once: true });
    const collect = (chunk, stdout) => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { overflow = true; terminate(); return; }
      if (stdout) events += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", chunk => collect(chunk, true));
    child.stderr.on("data", chunk => collect(chunk, false));
    child.stdin.on("error", () => {}); // CLI can reject the model before reading stdin.
    child.stdin.end(prompt);
    const cleanup = () => { clearTimeout(timer); clearTimeout(escalation); signal.removeEventListener("abort", cancel); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", (code, exitSignal) => {
      cleanup();
      resolveResult({ code, signal: exitSignal, events, stderr, timedOut, overflow,
        lockBusy: Boolean(invocation.lockPath && code === PROFILE_LOCK_BUSY_CODE) });
    });
  });
}

function validateSnapshot(snapshot) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(snapshot.repository) || !/^[1-9]\d*$/u.test(String(snapshot.pr))
    || !SHA.test(snapshot.base) || !SHA.test(snapshot.head)
    || !/^[1-9]\d*$/u.test(String(snapshot.runId)) || !/^[1-9]\d*$/u.test(String(snapshot.runAttempt))) {
    throw new Error("Некорректный снимок раунда.");
  }
}

export function assertCurrentPR(pr, snapshot, reviewDrafts) {
  if (pr.state !== "open" || (pr.draft !== false && !(pr.draft === true && reviewDrafts))
    || pr.base?.sha !== snapshot.base || pr.head?.sha !== snapshot.head) throw new Error("Снимок PR устарел или остановлен.");
}

async function reportAt(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_RESULT || info.size === 0) return { present: true, valid: false };
    const raw = await readFile(path, "utf8");
    let report;
    try { report = JSON.parse(raw); } catch { return { present: true, valid: false }; }
    // The trusted publisher still applies its full semantic/path/language checks.
    const valid = report && typeof report === "object" && !Array.isArray(report)
      && Object.keys(report).length === 1 && Array.isArray(report.findings) && report.findings.length <= 20;
    return { present: true, valid, raw };
  } catch (error) { if (error.code === "ENOENT") return { present: false, valid: false }; throw error; }
}

// The permanent exclusive claim is the local record of this workflow round.
// A crash leaves it claimed, so recovery cannot silently launch a second fallback.
// Workflow reruns additionally have fallback disabled by runAttempt != 1.
export async function runRound({ root, snapshot, fallbackEnabled, currentPR,
  execute = executeCodex, signal = new AbortController().signal, primaryModel = PRIMARY_MODEL,
  profileRoot = null, profileWaitMs = DEFAULT_PROFILE_WAIT_MS,
  profileRetryMs = DEFAULT_PROFILE_RETRY_MS, sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  now = () => Date.now() }) {
  validateSnapshot(snapshot);
  if (!MODELS.has(primaryModel)) throw new Error("Недопустимая основная модель.");
  root = resolve(root);
  const inputDir = join(root, "input");
  const outputDir = join(root, "output");
  const promptPath = join(inputDir, "prompt.txt");
  const schemaPath = join(inputDir, "review.schema.json");
  const [prompt, schema] = await Promise.all([readFile(promptPath), readFile(schemaPath)]);
  JSON.parse(schema.toString("utf8"));
  const hash = (a, b) => createHash("sha256").update(a).update("\0").update(b).digest("hex");
  const inputHash = hash(prompt, schema);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const claim = await open(join(outputDir, "round.claim"), "wx", 0o600);
  await claim.writeFile(JSON.stringify({ snapshot, inputHash }));
  await claim.close();
  const audit = { version: 2, snapshot, inputHash, status: "claimed", attempts: [],
    fallbackReserved: false, acceptedModel: null, failure: null, busyProfiles: [], exhaustedProfiles: [] };
  const auditPath = join(outputDir, "round.json");
  const persist = async () => {
    const temp = `${auditPath}.${randomUUID()}`;
    await writeFile(temp, JSON.stringify(audit, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, auditPath);
  };
  const guard = async () => {
    if (signal.aborted) throw new Error("Раунд отменён.");
    const [nowPrompt, nowSchema] = await Promise.all([readFile(promptPath), readFile(schemaPath)]);
    if (hash(nowPrompt, nowSchema) !== inputHash) throw new Error("Вход ревью изменился.");
    await currentPR();
    if (signal.aborted) throw new Error("Раунд отменён.");
  };
  const availableSlots = profileRoot
    ? (primaryModel === PRIMARY_MODEL
      ? CODEX_SLOTS
      : CODEX_SLOTS.filter(slot => slot.model === FALLBACK_MODEL))
    : [{ slot: primaryModel === PRIMARY_MODEL ? "single-spark" : "single-sol", profileId: null, model: primaryModel },
      ...(primaryModel === PRIMARY_MODEL ? [{ slot: "single-sol", profileId: null, model: FALLBACK_MODEL }] : [])];
  const attempt = async ({ model, profileId, slot }, reason) => {
    await guard();
    const id = randomUUID();
    const dir = join(root, id);
    const workDir = join(dir, "empty-workspace");
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const resultPath = join(dir, "review.json");
    const record = { id, slot, profileId, model, reasoningEffort: "xhigh", serviceTier: model === FALLBACK_MODEL ? "default" : null, reason,
      previousId: audit.attempts.at(-1)?.id ?? null, status: "reserved" };
    audit.attempts.push(record);
    if (reason) audit.fallbackReserved = true;
    audit.status = "running";
    await persist(); // Reservation precedes launch and survives an uncertain launch.
    await guard();
    let result;
    try {
      result = await execute({ model, profileRoot, profileId, slot, workDir, schemaPath, resultPath, prompt, signal });
    } catch (error) {
      record.status = "interrupted";
      record.diagnostic = { category: "execution_failed",
        errorCode: LAUNCH_CODES.has(error?.code) ? error.code : null };
      await persist();
      throw error;
    }
    if (result.lockBusy) {
      record.status = "busy";
      record.diagnostic = { category: "profile_busy", lockBusy: true };
      await persist();
      return { accepted: false, reason: null, profileBusy: true };
    }
    record.status = "finished";
    record.exitCode = result.code;
    record.signal = result.signal ?? null;
    const report = await reportAt(resultPath);
    record.diagnostic = attemptDiagnostic({ model, result, report });
    await persist();
    await guard();
    if (result.code === 0 && !result.signal && !result.timedOut && !result.overflow && report.valid) {
      // Each process has a distinct result path. A late primary cannot replace this file.
      await writeFile(join(outputDir, "review.json"), report.raw, { flag: "wx", mode: 0o600 });
      audit.status = "accepted";
      audit.acceptedModel = model;
      await persist();
      return { accepted: true, reason: null };
    }
    const reasonCode = result.overflow ? null : fallbackReason({ ...result, model, reportPresent: report.present });
    return { accepted: false, reason: reasonCode };
  };
  await persist();
  try {
    let previous = null;
    const exhaustedProfiles = new Set();
    // A slot that finished in this round is never launched again, while a slot that
    // returned lockBusy stays eligible for the next pass. The wait deadline is set
    // once and is not reset by a repeated pass.
    const completedSlots = new Set();
    const deadline = now() + Math.max(0, Number(profileWaitMs) || 0);
    let terminalFailure = false;
    let sawBusy = false;
    while (true) {
      const busyThisPass = new Set();
      sawBusy = false;
      for (const slot of availableSlots) {
        if (completedSlots.has(slot.slot)) continue;
        if (slot.profileId && (exhaustedProfiles.has(slot.profileId) || busyThisPass.has(slot.profileId))) continue;
        if (previous) {
          if (!previous.reason) { terminalFailure = true; break; }
          const accountRotation = previous.reason === "account_limit";
          const canUseFallback = fallbackEnabled && snapshot.runAttempt === 1
            && (!audit.fallbackReserved || Boolean(profileRoot));
          if (!accountRotation && !canUseFallback) { terminalFailure = true; break; }
        }
        const result = await attempt(slot, previous?.reason ?? null);
        if (result.accepted) return audit;
        if (result.profileBusy) {
          sawBusy = true;
          if (slot.profileId) busyThisPass.add(slot.profileId);
          if (slot.profileId && !audit.busyProfiles.includes(slot.profileId)) audit.busyProfiles.push(slot.profileId);
          continue;
        }
        // A finished slot is closed for this round: a later pass may only recheck
        // profiles that are still busy, so it cannot reserve a second fallback or
        // rotation for the same slot.
        completedSlots.add(slot.slot);
        previous = result;
        if (result.reason === "account_limit" && slot.profileId) {
          exhaustedProfiles.add(slot.profileId);
          if (!audit.exhaustedProfiles.includes(slot.profileId)) audit.exhaustedProfiles.push(slot.profileId);
        }
        if (!result.reason) { terminalFailure = true; break; }
      }
      if (terminalFailure || !sawBusy || now() >= deadline) break;
      await sleep(Math.min(Math.max(0, Number(profileRetryMs) || 0), Math.max(0, deadline - now())));
    }
    audit.failure = audit.fallbackReserved ? "fallback_unavailable"
      : (sawBusy ? "profile_busy_timeout" : (previous?.reason ?? "no_eligible_report"));
    audit.status = "unavailable";
    await persist();
    throw new Error(`Ревью Codex не получено: ${audit.failure}.`);
  } catch (error) {
    if (audit.status !== "unavailable") {
      audit.status = signal.aborted ? "cancelled" : "interrupted";
      audit.failure = signal.aborted ? "cancelled" : "guard_or_execution_failure";
      await persist();
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => controller.abort());
  const snapshot = { repository: process.env.REPOSITORY, pr: process.env.PR_NUMBER,
    base: process.env.BASE_SHA, head: process.env.HEAD_SHA,
    runId: process.env.GITHUB_RUN_ID, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
  runRound({ root: process.env.REVIEW_ROOT, snapshot,
    primaryModel: process.env.REVIEW_MODEL || PRIMARY_MODEL,
    fallbackEnabled: process.env.CODEX_FALLBACK_ENABLED === "true",
    profileRoot: process.env.CODEX_ACCOUNT_PROFILE_ROOT || null,
    signal: controller.signal,
    currentPR: async () => {
      const raw = execFileSync("gh", ["api", `repos/${snapshot.repository}/pulls/${snapshot.pr}`],
        { encoding: "utf8", timeout: 15_000, maxBuffer: MAX_OUTPUT, stdio: ["ignore", "pipe", "pipe"] });
      assertCurrentPR(JSON.parse(raw), snapshot, process.env.REVIEW_DRAFTS === "true");
    },
  }).then(async audit => {
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT,
      `review_model=${audit.acceptedModel}\nfallback_used=${audit.fallbackReserved}\n`, { flag: "a" });
    console.log(`Codex: ${audit.acceptedModel}, xhigh, service_tier=${audit.attempts.at(-1).serviceTier ?? "не задан"}; резерв: ${audit.fallbackReserved}.`);
  }).catch(() => {
    // Error text can contain a child stderr or a transport response. Only the
    // bounded, non-sensitive audit enums leave the runner.
    console.error("Ревью Codex не получено; причина и попытки записаны в round.json.");
    process.exitCode = 1;
  });
}
