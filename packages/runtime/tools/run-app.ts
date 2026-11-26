import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { buildStarterPlugins, installStarterPlugins } from "../../../app/scripts/starter-plugins.ts";
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
  let plugins = process.env.TOKAMAK_PLUGIN_DIR;
  if (plugins === undefined) {
    plugins = resolve(root, "app/.dev/run-app/plugins");
    buildStarterPlugins();
    await rm(plugins, { recursive: true, force: true });
    await installStarterPlugins(plugins);
  }
  const running = await ensure(binary, plugins, directory, "plugins");
  console.log(`Local server: pid ${running.pid}, ${running.url} (independent of desktop)`);
}
