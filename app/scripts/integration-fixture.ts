import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtempDisposable, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const directory = resolve(process.env.TOKAMAK_PLUGIN_DIR ?? `${root}/app/.dev/integration/plugins`);
async function install(id: string, plugin: string) {
  const result = spawnSync("proto", ["run", "bun", "--", "packages/build/src/build.ts", plugin], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Building ${id} exited ${result.status}`);
  await mkdir(`${directory}/${id}`, { recursive: true });
  await cp(resolve(root, plugin, "dist"), `${directory}/${id}/dist`, { recursive: true });
}

await install("fixture", process.env.TOKAMAK_FIXTURE_SOURCE ?? "app/tests/fixtures/integration");
if (process.env.TOKAMAK_OTHER_DRAFT_SOURCE) {
  await install("other-draft", process.env.TOKAMAK_OTHER_DRAFT_SOURCE);
}
if (process.argv.includes("--with-fixture-sign-in")) {
  // Server tests also use this source. Give the browser build its own generated files and dependencies.
  await using scratch = await mkdtempDisposable(join(tmpdir(), "tokamak-sign-in-"));
  const plugin = join(scratch.path, "fixture-sign-in");
  await cp(join(root, "packages/server/tests/fixtures/sign-in"), plugin, {
    recursive: true,
    filter: (path) => !["dist", "node_modules"].includes(basename(path)),
  });
  await symlink(join(root, "app/node_modules"), join(plugin, "node_modules"), "dir");
  await writeFile(
    join(plugin, "src/server/tsconfig.json"),
    JSON.stringify({ extends: join(root, "tsconfig.json") }),
  );
  await install("fixture-sign-in", plugin);
}
if (process.argv.includes("--reload")) {
  const result = spawnSync(
    "cargo",
    [
      "run",
      "--locked",
      "-p",
      "server",
      "--bin",
      "tokamak-server",
      "--",
      "plugin",
      "reload",
      "integration-fixture",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
console.log(`Integration plugins: ${directory}`);
