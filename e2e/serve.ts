// The browser suite's server: app/scripts/server.ts, but the server process gets the
// sealed chat sandbox HOME and PATH so ACP can only discover the scripted agent.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(`${root}/app/.dev/serve-`);
try {
  const child = spawn(
    `${root}/target/debug/tokamak`,
    [
      "--local-dir",
      process.env.TOKAMAK_SERVER_DIR!,
      "--data",
      `${directory}/store`,
      "--listen",
      "127.0.0.1:43123",
      "--plugins",
      process.env.TOKAMAK_PLUGIN_DIR!,
    ],
    {
      // The server treats stdin closing as its parent going away.
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, HOME: process.env.CHAT_SANDBOX_HOME, PATH: process.env.CHAT_SANDBOX_PATH },
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  process.exitCode = await new Promise<number>((done) => child.on("exit", (code) => done(code ?? 1)));
} finally {
  await rm(directory, { recursive: true, force: true });
}
