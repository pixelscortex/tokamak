// The local part as the desktop client starts it, and the `fake-agent` command,
// for any test runtime (Bun or Node): the server harness and the browser suite.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

// Ask the server's selector so the test client has the same platform defaults.
export function selectedRuntime(binary) {
  const runtime = execFileSync(binary, ["--plugin-runtime"], { encoding: "utf8" }).trim();
  assert.ok(runtime === "quickjs" || runtime === "bun", `Unexpected plugin runtime: ${runtime}`);
  return { binary, runtime };
}

/**
 * Launches a plugin's local worker for server-only fixtures
 * (the Runner implementation is in packages/runner/src/local.rs): the installed, hash-checked `local-entry.js`
 * and `local.js` with the selected runtime and the desktop’s short environment.
 * Programs started with `ctx.proc` inherit exactly that environment.
 * `installed(id)` is the folder holding a plugin's build.
 */
export function localLauncher({ binary, runtime }, installed, env, observe) {
  const quickjs = runtime === "quickjs";
  const host = quickjs
    ? resolve(
        process.env.TOKAMAK_TEST_PLUGIN_HOST ??
          process.env.TOKAMAK_PLUGIN_HOST ??
          join(dirname(binary), "tokamak-plugin-host"),
      )
    : undefined;

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
    if (host) {
      assert.equal(basename(host), "tokamak-plugin-host", `Expected the QuickJS plugin host, got ${host}`);
      assert.ok(
        await stat(host)
          .then((file) => file.isFile())
          .catch(() => false),
        `Missing plugin host: ${host}`,
      );
      await access(host, constants.X_OK);
    }

    const command = host ? [host] : [bunPath(), join(root, "local-entry.js")];
    const worker = spawn(command[0], [...command.slice(1), join(root, "local.js")], {
      detached: quickjs,
      stdio: ["pipe", "pipe", "inherit"],
      cwd: env.HOME,
      env: { ...env, TOKAMAK_WORKER_LANE: "local" },
    });
    worker.stdin.on("error", (error) => closed(String(error)));
    const exited = new Promise((resolve) => {
      worker.once("exit", resolve);
      worker.once("error", (error) => {
        closed(String(error));
        resolve();
      });
    });
    void (async () => {
      try {
        for await (const line of createInterface({ input: worker.stdout })) {
          const frame = JSON.parse(line);
          observe?.(artifact.id, frame, "fromWorker");
          receive(frame);
        }
        closed("Local worker exited");
      } catch (error) {
        closed(String(error));
      }
    })();
    return {
      // A provider's local code (the fake agent) loads into its contract owner's worker (ai).
      load: async (provider) => join(await verified(provider), "local.js"),
      async send(value) {
        const hold = observe?.(artifact.id, value, "toWorker");
        if (hold) await hold;
        worker.stdin.write(JSON.stringify(value) + "\n");
      },
      async close() {
        if (!quickjs) worker.kill();
        worker.stdin.end();
        await exited;
      },
    };
  };
}

/** Boots the same private Runner as the desktop, with a disposable workspace. */
export async function startRunner({ binary, plugins, directory, env }) {
  const { randomBytes } = await import("node:crypto");
  const { runnerLauncher } = await import("../../packages/runtime/js/runner.ts");
  await mkdir(directory, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const child = spawn(binary, ["--desktop", "--data", join(directory, "store"), "--plugins", plugins], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  const lines = createInterface({ input: child.stdout });
  let stopping;
  function stop() {
    if (stopping) return stopping;
    child.stdin.end();
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    return (stopping = exited.finally(() => {
      clearTimeout(deadline);
      lines.close();
    }));
  }
  try {
    const ws = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Runner readiness timed out")), 30_000);
      exited.then((status) => {
        clearTimeout(deadline);
        reject(new Error(`Runner exited before readiness: ${status}`));
      });
      lines.on("line", (line) => {
        const match = /^Tokamak listening on (ws:\/\/127\.0\.0\.1:\d+\/ws)$/.exec(line);
        if (!match) return;
        clearTimeout(deadline);
        resolve(match[1]);
      });
      child.stdin.write(token + "\n");
    });
    const endpoint = { ws, http: new URL(ws).origin.replace(/^ws:/, "http:"), token };
    return { endpoint, launch: runnerLauncher(async () => endpoint), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
