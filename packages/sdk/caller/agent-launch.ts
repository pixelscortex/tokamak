/// <reference types="node" />
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { LaunchSettings } from "../src/agent-turn";

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function threadHome(threadId: string) {
  const data = process.env.TOKAMAK_APP_DATA_DIR;
  if (!data || !isAbsolute(data)) throw new Error("The Runner's data folder is unavailable.");
  return join(data, "ai", "launch-homes", digest(threadId));
}

async function clearDirectory(directory: string) {
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, child.name);
    if (child.isDirectory()) await clearDirectory(path);
    else await unlink(path);
  }
  await rmdir(directory);
}

/** Remove this Runner's homes after Chat deletes the thread. */
export async function removeAgentLaunchHomes(threadId: string) {
  await clearDirectory(threadHome(threadId)).catch((cause: unknown) => {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  });
}

const claudeInherited = /^(?:ANTHROPIC_|CLAUDE_|AWS_BEARER_TOKEN_BEDROCK$)/;
const codexInherited = /^(?:OPENAI_|CODEX_)/;

/** Prepare a CLI's environment for setup or a turn in the same private home. */
export async function withAgentLaunch<T>(
  settings: LaunchSettings,
  cli: "claude" | "codex",
  turn: (settings: LaunchSettings) => Promise<T>,
): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(settings.identity)) throw new Error("Invalid agent launch identity.");
  const directory = join(threadHome(settings.threadId), cli, settings.identity);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Also protect an existing directory, independently of the Runner's umask.
  await chmod(directory, 0o700);
  const homeVariable = cli === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const inherited = cli === "claude" ? claudeInherited : codexInherited;
  const env = new Map<string, string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !inherited.test(name)) env.set(name, value);
  }
  for (const [name, value] of Object.entries(settings.env)) {
    // An empty secure-storage override would select Claude's default Keychain service.
    if (cli === "claude" && name === "CLAUDE_SECURESTORAGE_CONFIG_DIR") continue;
    env.set(name, value);
  }
  env.set(homeVariable, directory);
  return turn({ ...settings, env: Object.fromEntries(env) });
}
