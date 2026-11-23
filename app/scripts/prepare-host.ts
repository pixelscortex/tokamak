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

const info = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
if (info.status !== 0) throw new Error("Cannot determine Rust target");
const native = info.stdout.match(/^host: (.+)$/m)?.[1];
if (!native) throw new Error("Cannot determine native Rust target");
const target = process.env.TAURI_ENV_TARGET_TRIPLE || native;
const cross = target !== native;
const suffix = target.includes("-windows-") ? ".exe" : "";
const hostRequired = target.endsWith("-apple-darwin") || target.includes("-linux-");

buildStarterPlugins();
run("cargo", [
  "build",
  "--locked",
  "-p",
  "tokamak-runner",
  ...(hostRequired ? ["-p", "tokamak-plugin-host"] : []),
  ...(cross ? ["--target", target] : []),
  "--target-dir",
  "target",
  ...(release ? ["--release"] : []),
]);

const directory = `${root}app/src-tauri/dist`;
const build = `${root}target/${cross ? target + "/" : ""}${release ? "release" : "debug"}`;
await mkdir(directory, { recursive: true });
for (const binary of ["tokamak-runner", ...(hostRequired ? ["tokamak-plugin-host"] : [])]) {
  const source = `${build}/${binary}${suffix}`;
  try {
    await cp(source, `${directory}/${binary}-${target}${suffix}`);
  } catch (cause) {
    throw new Error(`Could not stage required sidecar: ${source}`, { cause });
  }
}

await rm(`${directory}/plugins`, { recursive: true, force: true });
await installStarterPlugins(`${directory}/plugins`);
