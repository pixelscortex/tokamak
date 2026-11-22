import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { installStarterPlugins } from "./starter-plugins";
const root = fileURLToPath(new URL("../../", import.meta.url));
const parent = fileURLToPath(new URL("../.dev/", import.meta.url));
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(`${parent}server-`);
try {
  if (!process.env.TOKAMAK_PLUGIN_DIR) await installStarterPlugins(`${directory}/plugins`);
  const child = spawn(
    `${root}target/debug/tokamak-server`,
    [
      // --local-dir resets the listener, so the explicit port must follow it.
      ...(process.env.TOKAMAK_SERVER_DIR ? ["--local-dir", process.env.TOKAMAK_SERVER_DIR] : []),
      "--data",
      `${directory}/store`,
      "--listen",
      "127.0.0.1:43123",
      "--plugins",
      process.env.TOKAMAK_PLUGIN_DIR ?? `${directory}/plugins`,
    ],
    { stdio: "inherit", windowsHide: process.platform === "win32" },
  );
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
