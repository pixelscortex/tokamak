import { buildStarterPlugins, installStarterPlugins } from "./starter-plugins";
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const release = process.argv.includes("--release");
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
buildStarterPlugins();
run("cargo", [
  "build",
  "--locked",
  "-p",
  "server",
  "--bin",
  "tokamak-server",
  ...(release ? ["--release"] : []),
]);
{
  const info = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (info.status !== 0) throw new Error("Cannot determine Rust target");
  const target = process.env.TAURI_ENV_TARGET_TRIPLE || info.stdout.match(/^host: (.+)$/m)?.[1];
  if (!target) throw new Error("Cannot determine sidecar target");
  const directory = `${root}app/src-tauri/dist`;
  await mkdir(directory, { recursive: true });
  const suffix = process.platform === "win32" ? ".exe" : "";
  await cp(
    `${root}target/${release ? "release" : "debug"}/tokamak-server${suffix}`,
    `${directory}/tokamak-server-${target}${suffix}`,
  );
  await rm(`${directory}/plugins`, { recursive: true, force: true });
  await installStarterPlugins(`${directory}/plugins`);
}
