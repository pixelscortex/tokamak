import { spawnSync } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const directory = resolve(process.env.TOKAMAK_PLUGIN_DIR ?? `${root}/app/.dev/integration/plugins`);
for (const plugin of [
  "plugins/chat",
  process.env.TOKAMAK_FIXTURE_SOURCE ?? "app/tests/fixtures/integration",
]) {
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
if (process.argv.includes("--reload")) {
  const result = spawnSync(`${root}/target/debug/tokamak`, ["plugin", "reload", "integration-fixture"], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
console.log(`Integration plugins: ${directory}`);
