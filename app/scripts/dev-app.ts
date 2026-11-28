import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
const child = spawn(process.execPath, ["run", "tauri", "dev", ...process.argv.slice(2)], {
  cwd: app,
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
