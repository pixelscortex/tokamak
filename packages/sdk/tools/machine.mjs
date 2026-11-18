import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pluginCompilerOptions } from "./plugin-boundary.mjs";
import ts from "typescript";
import { resolve } from "node:path";
import { bunPluginBoundary } from "./plugin-boundary.mjs";
const [root, entry] = process.argv.slice(2);
await mkdir(resolve(root, ".tokamak"), { recursive: true });
const temporary = await mkdtemp(resolve(root, ".tokamak/machine-"));
try {
  const parent = [
    resolve(root, "src/machine/tsconfig.json"),
    resolve(root, "tsconfig.json"),
    resolve(import.meta.dirname, "../../../tsconfig.json"),
  ].find(existsSync);
  const inherited = ts.getParsedCommandLineOfConfigFile(
    parent,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} },
  );
  const config = resolve(temporary, "tsconfig.json");
  await Bun.write(
    config,
    JSON.stringify({
      extends: parent,
      compilerOptions: {
        types: ["node"],
        lib: ["ES2022", "DOM"],
        paths: pluginCompilerOptions(root, inherited?.options ?? {}).paths,
        noEmit: true,
        strict: true,
      },
      files: [entry],
      include: [],
      exclude: [],
    }),
  );
  const check = Bun.spawnSync([process.execPath, "check", "--no-script", "--project", config], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (check.exitCode !== 0) throw new Error("Machine service type check failed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
for (const [path, name, sourcemap] of [
  [entry, "machine.js", "external"],
  [resolve(import.meta.dirname, "../worker/entry.ts"), "machine-entry.js", "none"],
]) {
  const result = await Bun.build({
    entrypoints: [path],
    target: "node",
    format: "esm",
    packages: "bundle",
    sourcemap,
    naming: name,
    outdir: resolve(root, "dist"),
    plugins: [bunPluginBoundary(root)],
  });
  if (!result.success) throw new AggregateError(result.logs, "Machine bundle failed");
}
