// The local part as the desktop client starts it, and the `fake-agent` command,
// for any test runtime (Bun or Node): the server harness and the browser suite.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const program = fileURLToPath(new URL("./program.mjs", import.meta.url));
export const agentsFolder = fileURLToPath(new URL("./agents/", import.meta.url));

/** The fake agents: one plugin folder each under ./agents, named after the command it starts. */
export async function fakeAgents() {
  return (await readdir(agentsFolder, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** The pinned Bun: this process under Bun, else what the runner passed in TOKAMAK_E2E_BUN. */
export function bunPath() {
  const bun = process.versions.bun ? process.execPath : process.env.TOKAMAK_E2E_BUN;
  if (!bun) throw new Error("Run under Bun or set TOKAMAK_E2E_BUN");
  return bun;
}

/**
 * Puts each of `commands` (by default every fake agent's) in `bin`: a shell script
 * running the replay program with the pinned Bun, as `claude` or `codex`
 * would sit on PATH.
 */
export async function installFakeAgent(bin, commands) {
  await mkdir(bin, { recursive: true });
  for (const command of commands ?? (await fakeAgents())) {
    await writeFile(
      join(bin, command),
      `#!/bin/sh\nexec ${JSON.stringify(bunPath())} ${JSON.stringify(program)} "$@"\n`,
    );
    await chmod(join(bin, command), 0o755);
  }
}

/**
 * Launches a plugin's local worker the way the desktop client does
 * (app/src-tauri/src/local.rs): the installed, hash-checked `local-entry.js`
 * and `local.js` in Bun, with only the short environment the desktop passes.
 * Programs started with `ctx.proc` inherit exactly that environment.
 * `installed(id)` is the folder holding a plugin's build.
 */
export function localLauncher(installed, env) {
  async function verified(artifact) {
    const root = installed(artifact.id);
    for (const [name, hash] of [
      ["local-entry.js", artifact.entryHash],
      ["local.js", artifact.codeHash],
    ]) {
      const actual = createHash("sha256")
        .update(await readFile(join(root, name)))
        .digest("hex");
      if (actual !== hash) throw new Error(`${artifact.id}/${name} does not match the catalog`);
    }
    return root;
  }
  return async (artifact, receive, closed) => {
    const root = await verified(artifact);
    const worker = spawn(bunPath(), [join(root, "local-entry.js"), join(root, "local.js")], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: env.HOME,
      env: { ...env, TOKAMAK_WORKER_LANE: "local" },
    });
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    void (async () => {
      try {
        for await (const line of createInterface({ input: worker.stdout })) receive(JSON.parse(line));
        closed("Local worker exited");
      } catch (error) {
        closed(String(error));
      }
    })();
    return {
      // A provider's local code (the fake agent) loads into its contract owner's worker (ai).
      load: async (provider) => join(await verified(provider), "local.js"),
      async send(value) {
        worker.stdin.write(JSON.stringify(value) + "\n");
      },
      async close() {
        worker.kill();
        worker.stdin.end();
        await exited;
      },
    };
  };
}
