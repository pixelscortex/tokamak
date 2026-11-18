// A second server for the browser suite, in hosted mode on a loopback port: the
// "remote" server the connect flow adds. It serves the built app, requires the
// access token from TOKAMAK_E2E_HOSTED_TOKEN and, like serve.ts, only sees the
// sealed chat sandbox's HOME and PATH.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(`${root}/app/.dev/serve-hosted-`);
try {
  const child = spawn(
    `${root}/target/debug/tokamak`,
    [
      "--web",
      `${root}/app/dist`,
      "--data",
      `${directory}/store`,
      "--listen",
      "127.0.0.1:43124",
      "--plugins",
      process.env.TOKAMAK_E2E_HUB_PLUGIN_DIR!,
    ],
    {
      stdio: ["pipe", "inherit", "inherit"],
      env: {
        ...process.env,
        HOME: process.env.CHAT_SANDBOX_HOME,
        PATH: process.env.CHAT_SANDBOX_PATH,
        TOKAMAK_ACCESS_TOKEN: process.env.TOKAMAK_E2E_HOSTED_TOKEN,
      },
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  process.exitCode = await new Promise<number>((done) => child.on("exit", (code) => done(code ?? 1)));
} finally {
  await rm(directory, { recursive: true, force: true });
}
