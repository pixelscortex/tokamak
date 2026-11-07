/** Fixed internal app checks keep Node tooling separate from QuickJS sources.
 * Moon owns orchestration; Bun is already pinned by the invoking Moon task. */
import { spawnSync } from "node:child_process";

for (const command of [
  [process.execPath, "check", "--no-script", "--project", "tsconfig.json"],
  [process.execPath, "check", "--no-script", "--project", "tsconfig.tools.json"],
  ["cargo", "fmt", "--package", "tokamak-app", "--", "--check"],
  ["cargo", "check", "--locked", "--package", "tokamak-app", "--all-targets", "--jobs", "2"],
]) {
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
