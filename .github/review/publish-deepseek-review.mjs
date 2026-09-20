import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openSnapshot, sha256 } from "./deepseek-snapshot.mjs";
import { main as publish } from "./publish-claude-review.mjs";

export function verifyEvidence(input, output, baseSha, headSha) {
  const result = JSON.parse(readFileSync(join(output, "result.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(output, "snapshot-manifest.json"), "utf8"));
  const snapshot = openSnapshot(input, manifest);
  if (result.kind !== "c3" || result.state !== "completed" || result.role !== "DeepSeek" ||
      result.baseSha !== baseSha || result.headSha !== headSha || result.snapshotHash !== snapshot.hash ||
      result.requested?.model !== "deepseek-flash" || result.requested?.reasoning_effort !== "max" ||
      result.requested?.thinking?.type !== "enabled" || result.calls?.length !== 1 ||
      result.calls[0].model !== "deepseek-flash" || result.calls[0].finishReason !== "stop" ||
      result.reportHash !== sha256(readFileSync(join(output, "review.json")))) {
    throw new Error("Отчёт DeepSeek не подтверждён для этого снимка и профиля.");
  }
}

export async function main() {
  const input = process.env.DEEPSEEK_INPUT;
  const output = process.env.DEEPSEEK_OUTPUT;
  verifyEvidence(input, output, process.env.BASE_SHA, process.env.HEAD_SHA);
  process.env.REVIEW_MODEL = "deepseek-flash";
  process.env.REVIEW_JSON_FILE = join(output, "review.json");
  process.env.DIFF_PATH = join(input, "pull-request.diff");
  process.env.BINARY_MANIFEST_PATH = join(input, "binary-manifest.json");
  await publish();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("DeepSeek: публикация не подтверждена; сохранённый отчёт требует разбора."); process.exitCode = 1; });
}
