// A sealed environment for running the real server with ACP and a scripted agent.
// HOME and PATH are replaced so agent discovery can only find the scripted
// agent: real agent CLIs on this machine bill, and must never be launched here.
import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

function pinnedBun(): string {
  const result = spawnSync("proto", ["bin", "bun"], { cwd: root, encoding: "utf8" });
  const line = result.stdout
    .split("\n")
    .map((entry) => {
      try {
        return (JSON.parse(entry) as { message?: string }).message ?? "";
      } catch {
        return entry;
      }
    })
    .find((entry) => entry.startsWith("/"));
  if (!line) throw new Error("Could not find the pinned bun");
  return line.trim();
}

/** Installs chat and acp into `directory/plugins` and returns the sealed server environment. */
export async function prepareChatSandbox(
  directory: string,
  options: { build?: boolean; agents?: boolean } = {},
) {
  if (options.build !== false) {
    run("proto", ["run", "bun", "--", "packages/build/src/build.ts", "plugins/chat"]);
    run("proto", ["run", "bun", "--", "packages/build/src/build.ts", "plugins/acp"]);
  }
  for (const id of ["chat", "acp"]) {
    await mkdir(`${directory}/plugins/${id}`, { recursive: true });
    await cp(`${root}/plugins/${id}/dist`, `${directory}/plugins/${id}/dist`, { recursive: true });
  }
  const bin = `${directory}/bin`;
  const home = `${directory}/home`;
  await mkdir(bin, { recursive: true, mode: 0o755 });
  await mkdir(`${home}/project`, { recursive: true, mode: 0o755 });
  await chmod(bin, 0o755);
  await symlink(pinnedBun(), `${bin}/bun`);
  const agent = resolve(import.meta.dirname, "fixtures/scripted-agent.py");
  for (const name of options.agents === false ? [] : ["claude-agent-acp", "codex-acp"]) {
    await writeFile(`${bin}/${name}`, `#!/bin/sh\nexec /usr/bin/python3 ${JSON.stringify(agent)} "$@"\n`, {
      mode: 0o755,
    });
    await chmod(`${bin}/${name}`, 0o755);
  }
  return {
    home,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TOKAMAK_PLUGIN_DIR: `${directory}/plugins`,
    },
  };
}

// `proto run bun -- e2e/chat-sandbox.ts` serves a disposable store until stopped, on
// CHAT_SANDBOX_PORT (43123) for the app origin CHAT_SANDBOX_ORIGIN (http://127.0.0.1:1420).
if (import.meta.main) {
  await mkdir(`${root}/app/.dev`, { recursive: true });
  const directory = await mkdtemp(`${root}/app/.dev/chat-`);
  try {
    const sandbox = await prepareChatSandbox(directory, {
      build: !process.argv.includes("--no-build"),
      agents: !process.argv.includes("--no-agents"),
    });
    // Vite reads the capability from app/.dev/chat-sandbox.env: VITE_TOKAMAK_TOKEN=… vite
    const token = randomBytes(32).toString("hex");
    await mkdir(`${directory}/local`, { mode: 0o700 });
    await writeFile(`${directory}/local/server.token`, token, { mode: 0o600 });
    await writeFile(`${root}/app/.dev/chat-sandbox.env`, `VITE_TOKAMAK_TOKEN=${token}\n`, { mode: 0o600 });
    const child = spawn(
      `${root}/target/debug/tokamak`,
      [
        "--local-dir",
        `${directory}/local`,
        "--data",
        `${directory}/store`,
        "--listen",
        `127.0.0.1:${process.env.CHAT_SANDBOX_PORT ?? "43123"}`,
        "--plugins",
        sandbox.env.TOKAMAK_PLUGIN_DIR,
      ],
      {
        // The server treats stdin closing as its parent going away.
        stdio: ["pipe", "inherit", "inherit"],
        env: {
          ...process.env,
          ...sandbox.env,
          TOKAMAK_ALLOWED_ORIGINS: process.env.CHAT_SANDBOX_ORIGIN ?? "http://127.0.0.1:1420",
        },
      },
    );
    console.log(`Chat sandbox: ${directory}`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
    process.exitCode = await new Promise<number>((done) => child.on("exit", (code) => done(code ?? 1)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
