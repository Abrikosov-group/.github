import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PRIMARY_MODEL = "gpt-5.3-codex-spark";
export const FALLBACK_MODEL = "gpt-5.6-sol";
const MODELS = new Set([PRIMARY_MODEL, FALLBACK_MODEL]);
const SHA = /^[a-f0-9]{40}$/u;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_RESULT = 128 * 1024;

// Only structured CLI transport errors qualify. Model text, stderr echoes and
// invalid reports cannot request another model or a second review.
export function fallbackReason({ code, signal, events, reportPresent, timedOut }) {
  if (reportPresent || (signal && !timedOut) || (code === 0 && !timedOut)) return null;
  const errors = [];
  for (const line of events.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "error" || event.type === "turn.failed") {
      const error = event.error ?? event;
      errors.push({ ...error, status: error.status ?? event.status });
    }
  }
  const modelLimit = e => e.scope === "model" && e.model === PRIMARY_MODEL
    && (e.status === 429 || e.code === "model_rate_limit_exceeded");
  // Access and shared quota failures take precedence over a model-specific one.
  if (errors.some(e => /authentication|unauthori[sz]ed|invalid.api.key|insufficient.quota|usage.limit|credit|billing/iu.test(`${e.code ?? e.type ?? ""} ${e.message ?? ""}`)
    || [401, 403].includes(e.status) || (e.status === 429 && !modelLimit(e)))) return null;
  // A transient error earlier in the stream does not override the terminal
  // error (for example, an invalid or oversized input after reconnection).
  const lastError = errors.at(-1);
  if (lastError && /context.{0,30}(window|length|limit)|input.{0,30}(large|invalid|limit)|invalid.{0,10}schema/iu.test(`${lastError.code ?? ""} ${lastError.message ?? ""}`)) return null;
  if (timedOut) return "primary_timeout";
  for (const e of lastError ? [lastError] : []) {
    const message = `${e.code ?? e.type ?? ""} ${e.message ?? ""}`;
    if (modelLimit(e)) return "primary_model_limit";
    if (message.includes(PRIMARY_MODEL) && /not supported|not available|does not exist|model.not.found/iu.test(message)) return "primary_model_unavailable";
    if (/server_error|internal_server_error|service_unavailable|connection_reset|connection_error/iu.test(message)
      || [500, 502, 503, 504].includes(e.status)) return "provider_technical_failure";
  }
  return null;
}

export function codexInvocation({ model, workDir, schemaPath, resultPath, env = process.env }) {
  if (!MODELS.has(model)) throw new Error("Недопустимая модель Codex.");
  const cleanEnv = {};
  for (const key of ["HOME", "PATH", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (env[key]) cleanEnv[key] = env[key];
  }
  cleanEnv.CODEX_HOME = env.CODEX_HOME || join(env.HOME, ".codex");
  cleanEnv.TMPDIR = env.RUNNER_TEMP;
  const args = ["exec", "--model", model, "-c", 'model_reasoning_effort="xhigh"',
    "-c", 'service_tier="default"', "-c", 'web_search="disabled"',
    "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules"];
  for (const feature of ["shell_tool", "apps", "plugins", "browser_use", "computer_use", "image_generation", "multi_agent", "skill_search"]) args.push("--disable", feature);
  args.push("--color", "never", "--json", "--cd", workDir, "--output-schema", schemaPath, "--output-last-message", resultPath, "-");
  return { args, env: cleanEnv };
}

export async function executeCodex({ model, workDir, schemaPath, resultPath, prompt, signal,
  binary = "codex", timeoutMs = 20 * 60_000, env = process.env }) {
  const invocation = codexInvocation({ model, workDir, schemaPath, resultPath, env });
  return new Promise((resolveResult, reject) => {
    if (signal.aborted) { reject(new Error("Запуск отменён.")); return; }
    const child = spawn(binary, invocation.args, { env: invocation.env, cwd: workDir,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let events = "";
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
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { overflow = true; terminate(); return; }
      if (stdout) events += chunk.toString("utf8");
    };
    child.stdout.on("data", chunk => collect(chunk, true));
    child.stderr.on("data", chunk => collect(chunk, false));
    child.stdin.on("error", () => {}); // CLI can reject the model before reading stdin.
    child.stdin.end(prompt);
    const cleanup = () => { clearTimeout(timer); clearTimeout(escalation); signal.removeEventListener("abort", cancel); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", (code, exitSignal) => {
      cleanup();
      resolveResult({ code, signal: exitSignal, events, timedOut, overflow });
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
  execute = executeCodex, signal = new AbortController().signal, primaryModel = PRIMARY_MODEL }) {
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
  const audit = { version: 1, snapshot, inputHash, status: "claimed", attempts: [],
    fallbackReserved: false, acceptedModel: null, failure: null };
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
  const attempt = async (model, reason) => {
    await guard();
    const id = randomUUID();
    const dir = join(root, id);
    const workDir = join(dir, "empty-workspace");
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const resultPath = join(dir, "review.json");
    const record = { id, model, reasoningEffort: "xhigh", serviceTier: "default", reason,
      previousId: audit.attempts.at(-1)?.id ?? null, status: "reserved" };
    audit.attempts.push(record);
    if (reason) audit.fallbackReserved = true;
    audit.status = "running";
    await persist(); // Reservation precedes launch and survives an uncertain launch.
    await guard();
    const result = await execute({ model, workDir, schemaPath, resultPath, prompt, signal });
    record.status = "finished";
    record.exitCode = result.code;
    record.signal = result.signal ?? null;
    const report = await reportAt(resultPath);
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
    const reasonCode = result.overflow ? null : fallbackReason({ ...result, reportPresent: report.present });
    return { accepted: false, reason: reasonCode };
  };
  await persist();
  try {
    const primary = await attempt(primaryModel, null);
    if (primary.accepted) return audit;
    if (fallbackEnabled && snapshot.runAttempt === 1 && primaryModel !== FALLBACK_MODEL && primary.reason) {
      const fallback = await attempt(FALLBACK_MODEL, primary.reason);
      if (fallback.accepted) return audit;
      audit.failure = "fallback_unavailable";
    } else audit.failure = primary.reason ?? "no_eligible_report";
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
  runRound({ root: process.env.REVIEW_ROOT, snapshot, fallbackEnabled: process.env.CODEX_FALLBACK_ENABLED === "true",
    signal: controller.signal,
    currentPR: async () => {
      const raw = execFileSync("gh", ["api", `repos/${snapshot.repository}/pulls/${snapshot.pr}`],
        { encoding: "utf8", timeout: 15_000, maxBuffer: MAX_OUTPUT, stdio: ["ignore", "pipe", "pipe"] });
      assertCurrentPR(JSON.parse(raw), snapshot, process.env.REVIEW_DRAFTS === "true");
    },
  }).then(async audit => {
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT,
      `review_model=${audit.acceptedModel}\nfallback_used=${audit.fallbackReserved}\n`, { flag: "a" });
    console.log(`Codex: ${audit.acceptedModel}, xhigh, service_tier=default; резерв: ${audit.fallbackReserved}.`);
  }).catch(() => {
    // Error text can contain a child stderr or a transport response. Only the
    // bounded, non-sensitive audit enums leave the runner.
    console.error("Ревью Codex не получено; причина и попытки записаны в round.json.");
    process.exitCode = 1;
  });
}
