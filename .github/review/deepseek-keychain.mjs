import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ReviewFailure } from "./deepseek-client.mjs";

// A stable local client has a per-item Keychain ACL. Ordinary C2 runs cannot open UI.
// The one-time interactive transfer is performed separately while the owner is present.
export function keychainCredential({ home = process.env.HOME, execute = spawnSync, inspect = lstatSync, realpath = realpathSync, uid = process.getuid?.() } = {}) {
  const client = join(home, "Library/Application Support/Abrikosov/Review Credentials/DeepSeekReviewCredential");
  try {
    const stat = inspect(client);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== uid || realpath(client) !== client) {
      throw new Error();
    }
    const result = execute(client, [], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000, maxBuffer: 8192, env: { HOME: home, PATH: "/usr/bin:/bin" } });
    if (result.status !== 0 || typeof result.stdout !== "string" || result.stdout.trim().length < 16) throw new Error();
    return result.stdout.trim();
  } catch { throw new ReviewFailure("credential_unavailable"); }
}
