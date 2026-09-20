import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ReviewFailure } from "./deepseek-client.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = () => { throw new ReviewFailure("snapshot_invalid_or_changed"); };

// A controller-owned manifest is the complete allowlist, never a model-supplied path glob.
export function openSnapshot(root, manifest) {
  const rootPath = realpathSync(root);
  if (!manifest || Array.isArray(manifest) || typeof manifest !== "object" ||
      Object.keys(manifest).length < 1 || Object.keys(manifest).length > 20000) fail();
  const entries = new Map(Object.entries(manifest));
  function bytes(path) {
    if (!entries.has(path) || isAbsolute(path) || path.includes("\\") ||
        path.split("/").some((part) => ["", ".", ".."].includes(part)) ||
        /[\u0000-\u001f\u007f]/u.test(path) || !/^[a-f0-9]{64}$/u.test(entries.get(path))) fail();
    const target = resolve(rootPath, path);
    if (relative(rootPath, target).startsWith("..")) fail();
    for (let current = target; current !== rootPath; current = dirname(current)) {
      if (lstatSync(current).isSymbolicLink()) fail();
    }
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || realpathSync(target) !== target) fail();
    const value = readFileSync(target);
    if (sha256(value) !== entries.get(path)) fail();
    return value;
  }
  function verify() { for (const path of entries.keys()) bytes(path); }
  const accesses = [];
  let returnedBytes = 0;
  function execute(name, args) {
    let output;
    if (name === "list_files") {
      if (typeof args.prefix !== "string" || !Number.isInteger(args.offset) || args.offset < 0) fail();
      const matching = [...entries.keys()].filter((path) => path.startsWith(args.prefix));
      output = { paths: matching.slice(args.offset, args.offset + 200), total: matching.length };
    } else if (name === "read_file") {
      if (!Number.isInteger(args.start_line) || args.start_line < 1 ||
          !Number.isInteger(args.line_count) || args.line_count < 1 || args.line_count > 400) fail();
      const value = bytes(args.path);
      if (value.includes(0)) throw new ReviewFailure("binary_file_not_readable");
      const lines = value.toString("utf8").split("\n");
      output = { path: args.path, totalLines: lines.length,
        lines: lines.slice(args.start_line - 1, args.start_line - 1 + args.line_count)
          .map((line, index) => `${args.start_line + index}: ${line}`) };
    } else if (name === "search_text") {
      if (typeof args.text !== "string" || args.text.length < 1 || args.text.length > 200 ||
          typeof args.prefix !== "string") fail();
      const matches = [];
      let truncated = false;
      for (const path of entries.keys()) {
        if (!path.startsWith(args.prefix)) continue;
        const value = bytes(path);
        if (value.includes(0)) continue;
        const lines = value.toString("utf8").split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (!lines[index].includes(args.text)) continue;
          if (matches.length === 100) { truncated = true; break; }
          matches.push({ path, line: index + 1, text: lines[index].slice(0, 500) });
        }
        if (truncated) break;
      }
      output = { matches, truncated };
    } else throw new ReviewFailure("tool_not_allowed");
    const content = JSON.stringify(output);
    returnedBytes += Buffer.byteLength(content);
    if (Buffer.byteLength(content) > 128 * 1024 || returnedBytes > 2 * 1024 * 1024) {
      throw new ReviewFailure("tool_output_budget_exceeded");
    }
    accesses.push({ tool: name, ...(name === "read_file" ? { path: args.path, startLine: args.start_line, lineCount: args.line_count } : {}), bytes: Buffer.byteLength(content) });
    return content;
  }
  verify();
  return { verify, bytes, execute, accesses, hash: sha256(JSON.stringify([...entries].sort())) };
}

function tool(name, description, properties) {
  return { type: "function", function: { name, description,
    parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } } };
}
export const SNAPSHOT_TOOLS = [
  tool("list_files", "Список файлов разрешённого снимка; страницы по 200 путей, пути относительно корня пакета без input/.", { prefix: { type: "string" }, offset: { type: "integer", minimum: 0 } }),
  tool("read_file", "Читать текстовые строки файла снимка, только чтение. Пути относительно корня пакета без input/.", { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, line_count: { type: "integer", minimum: 1, maximum: 400 } }),
  tool("search_text", "Поиск буквального текста в разрешённых файлах, до 100 результатов.", { prefix: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 200 } }),
];
