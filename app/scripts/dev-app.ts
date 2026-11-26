import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildStarterPlugins, installStarterPlugins } from "./starter-plugins";

const app = fileURLToPath(new URL("../", import.meta.url));
let plugins = process.env.TOKAMAK_PLUGIN_DIR;
if (plugins === undefined) {
  plugins = `${app}.dev/plugins`;
  buildStarterPlugins();
  await rm(plugins, { recursive: true, force: true });
  await installStarterPlugins(plugins);
}

const child = spawn(process.execPath, ["run", "tauri", "dev", ...process.argv.slice(2)], {
  cwd: app,
  env: { ...process.env, TOKAMAK_PLUGIN_DIR: plugins },
  stdio: "inherit",
  windowsHide: process.platform === "win32",
});
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
