import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const parent = fileURLToPath(new URL("../.dev/", import.meta.url));
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(`${parent}server-`);
try {
  await mkdir(`${directory}/plugins/chat`, { recursive: true });
  await cp(`${root}plugins/chat/dist`, `${directory}/plugins/chat/dist`, { recursive: true });
  const child = spawn(
    `${root}target/debug/tokamak`,
    [
      "--data",
      `${directory}/store`,
      "--listen",
      "127.0.0.1:43123",
      "--plugins",
      process.env.TOKAMAK_PLUGIN_DIR ?? `${directory}/plugins`,
    ],
    { stdio: "inherit" },
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
