import { spawnSync } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const directory = resolve(process.env.TOKAMAK_PLUGIN_DIR ?? `${root}/app/.dev/integration/plugins`);
const fixture = process.env.TOKAMAK_FIXTURE_SOURCE ?? "app/tests/fixtures/integration";
if (process.argv.includes("--reload")) {
  if (!process.env.TOKAMAK_SERVER_DIR)
    throw new Error("Set TOKAMAK_SERVER_DIR to the disposable local server directory");
  for (const args of [
    ["add", fixture],
    ["reload", "integration-fixture"],
  ]) {
    const result = spawnSync("proto", ["run", "bun", "--", "run", "--silent", "tokamak", "plugin", ...args], {
      cwd: root,
      env: { ...process.env, TOKAMAK_SERVER: undefined, TOKAMAK_TOKEN: undefined },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
for (const plugin of ["plugins/chat", fixture]) {
  const result = spawnSync("proto", ["run", "bun", "--", "packages/build/src/build.ts", plugin], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const id = plugin === "plugins/chat" ? "chat" : "fixture";
  await mkdir(`${directory}/${id}`, { recursive: true });
  await cp(resolve(root, plugin, "dist"), `${directory}/${id}/dist`, { recursive: true });
}
console.log(`Integration plugins: ${directory}`);
