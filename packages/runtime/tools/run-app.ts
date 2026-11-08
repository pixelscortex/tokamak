import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { ensure, localDirectory, status, stop } from "./local-server";

const [command = "app", profile = "release"] = process.argv.slice(2);
if (!["app", "start", "stop", "status"].includes(command) || !["debug", "release"].includes(profile)) {
  throw new Error("Expected app, start, stop or status, optionally followed by debug or release");
}
const root = fileURLToPath(new URL("../../../", import.meta.url));
const suffix = process.platform === "win32" ? ".exe" : "";
let binary = resolve(root, `target/${profile}/tokamak${suffix}`);
if (!existsSync(binary) && ["stop", "status"].includes(command)) {
  binary = resolve(root, `target/${profile === "debug" ? "release" : "debug"}/tokamak${suffix}`);
}
const directory = localDirectory(binary, root);
if (command === "stop") {
  await stop(directory);
  console.log("Local server stopped");
} else if (command === "status") {
  const running = await status(directory);
  console.log(running ? `Local server: pid ${running.pid}, ${running.url}` : "Local server not running");
} else {
  const running = await ensure(binary, resolve(root, "app/dist/bundle.js"), directory);
  console.log(`Local server: pid ${running.pid}, ${running.url} (independent of desktop)`);
  if (command === "app") {
    const child = spawn(resolve(root, `target/${profile}/tokamak-desktop${suffix}`), [], {
      stdio: "inherit", env: { ...process.env, TOKAMAK_SERVER_DIR: directory },
    });
    child.on("error", error => { console.error(error.message); process.exitCode = 1; });
    child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  }
}
