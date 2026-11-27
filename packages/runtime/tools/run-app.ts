import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { ensure, localDirectory, status, stop } from "./local-server";
import { serverBinaryCandidates } from "./server-binary";

const [command = "status", profile = "debug"] = process.argv.slice(2);
if (!["start", "stop", "status"].includes(command) || !["debug", "release"].includes(profile)) {
  throw new Error("Expected start, stop or status, optionally followed by debug or release");
}
const root = fileURLToPath(new URL("../../../", import.meta.url));
const suffix = process.platform === "win32" ? ".exe" : "";
const candidates = serverBinaryCandidates(command, profile, suffix).map((path) => resolve(root, path));
const binary = candidates.find((path) => existsSync(path)) ?? candidates[0]!;
const directory = localDirectory(binary, root);
if (command === "stop") {
  await stop(directory);
  console.log("Local server stopped");
} else if (command === "status") {
  const running = await status(directory);
  console.log(running ? `Local server: pid ${running.pid}, ${running.url}` : "Local server not running");
} else {
  const plugins =
    process.env.TOKAMAK_PLUGIN_DIR ?? resolve(localDirectory(binary, root, "--dev-local-path"), "plugins");
  if (process.env.TOKAMAK_PLUGIN_DIR === undefined) await mkdir(plugins, { recursive: true, mode: 0o700 });
  const running = await ensure(binary, plugins, directory, "plugins");
  console.log(`Local server: pid ${running.pid}, ${running.url} (independent of desktop)`);
}
