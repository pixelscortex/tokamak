import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const release = process.argv.includes("--release");
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// The dev server loads the whole plugins folder, so every plugin in it must be built.
for (const plugin of ["chat", "acp"])
  run("proto", ["run", "bun", "--", "packages/build/src/build.ts", `plugins/${plugin}`]);
run("cargo", ["build", "--locked", "-p", "server", "--bin", "tokamak", ...(release ? ["--release"] : [])]);
{
  const info = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (info.status !== 0) throw new Error("Cannot determine Rust target");
  const target = process.env.TAURI_ENV_TARGET_TRIPLE || info.stdout.match(/^host: (.+)$/m)?.[1];
  if (!target) throw new Error("Cannot determine sidecar target");
  const directory = `${root}app/src-tauri/dist`;
  await mkdir(directory, { recursive: true });
  const suffix = process.platform === "win32" ? ".exe" : "";
  await cp(
    `${root}target/${release ? "release" : "debug"}/tokamak${suffix}`,
    `${directory}/tokamak-${target}${suffix}`,
  );
  await rm(`${directory}/plugins`, { recursive: true, force: true });
  for (const plugin of await readdir(`${root}plugins`, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    // Ship built installations only; source trees and local secrets stay outside the app.
    try {
      await cp(`${root}plugins/${plugin.name}/dist`, `${directory}/plugins/${plugin.name}/dist`, {
        recursive: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
