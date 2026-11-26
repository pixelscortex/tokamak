/// <reference types="node" />
import { mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchSettings } from "../src/agent-turn";

async function clearDirectory(directory: string) {
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, child.name);
    if (child.isDirectory()) await clearDirectory(path);
    else await unlink(path);
  }
  await rmdir(directory);
}

/** Keep one private CLI home for the duration of an isolated turn. */
export async function withAgentLaunch<T>(
  settings: LaunchSettings,
  cli: "claude" | "codex",
  turn: (settings: LaunchSettings) => Promise<T>,
): Promise<T> {
  const homeVariable = cli === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const directory = await mkdtemp(join(tmpdir(), `tokamak-${cli}-`));
  try {
    const ignoreCase = platform() === "win32";
    const env = new Map<string, string>();
    for (const [name, value] of [...Object.entries(process.env), ...Object.entries(settings.env)]) {
      if (value !== undefined) env.set(ignoreCase ? name.toUpperCase() : name, value);
    }
    env.set(homeVariable, directory);
    return await turn({ env: Object.fromEntries(env), args: settings.args });
  } finally {
    await clearDirectory(directory).catch(() => {});
  }
}
