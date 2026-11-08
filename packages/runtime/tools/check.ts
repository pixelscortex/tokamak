import { spawnSync } from "node:child_process";

for (const [command, ...args] of [
  [process.execPath, "check", "--no-script", "--project", "tsconfig.json"],
  [process.execPath, "check", "--no-script", "--project", "tools/tsconfig.json"],
  ["cargo", "fmt", "--package", "runtime", "--", "--check"],
  ["cargo", "check", "--locked", "--package", "runtime", "--all-features", "--all-targets", "--jobs", "2"],
]) {
  const result = spawnSync(command!, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
