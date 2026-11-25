import { spawnSync } from "node:child_process";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Build the owners first so dependents can read their generated references.
export const starterPlugins = ["chat", "ai", "code", "claude", "codex", "basic-auth", "agent-proxy"] as const;
const root = fileURLToPath(new URL("../../", import.meta.url));

export function buildStarterPlugins() {
  for (const id of starterPlugins) {
    const build = spawnSync(
      process.execPath,
      [join(root, "packages/build/src/build.ts"), join(root, "plugins", id)],
      { cwd: root, stdio: "inherit" },
    );
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`Could not build starter plugin ${id}`);
  }
}

/** Copy built artifacts only; the installation never needs plugin source. */
export async function installStarterPlugins(destination: string) {
  for (const id of starterPlugins)
    await cp(join(root, "plugins", id, "dist"), join(destination, id, "dist"), { recursive: true });
}

if (import.meta.main) buildStarterPlugins();
