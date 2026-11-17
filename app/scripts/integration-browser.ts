import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const directory = process.env.TOKAMAK_SERVER_DIR;
if (!directory) throw new Error("Set TOKAMAK_SERVER_DIR to the disposable desktop server directory");
const identity = JSON.parse(await readFile(`${directory}/server.json`, "utf8"));
const token = await readFile(`${directory}/server.token`, "utf8");
const url = new URL(identity.url);
url.protocol = "http:";
url.pathname = "/";
const child = spawn("proto", ["run", "bun", "--", "run", "dev"], {
  cwd: resolve(import.meta.dirname, ".."),
  env: { ...process.env, VITE_TOKAMAK_HTTP: url.href, VITE_TOKAMAK_TOKEN: token },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", (code) => resolve(code ?? 0));
});
