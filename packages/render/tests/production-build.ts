/** Run the exact production entry in copied checkouts, then inspect composed
 * original mappings. Native runtime assertions remain in native_solid.rs. */
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { assertOriginalMapping } from "./source-maps";

const render = fileURLToPath(new URL("../", import.meta.url));
const output = join(render, "dist", "tests");
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, "production-build-"));
const failures: string[] = [];

try {
  for (const [checkout, fixture, result] of [
    ["typed", "typed-component.tsx", "production-typed.js"],
    ["checkout with spaces", "../../demo/main.tsx", "production-spaces.js"],
  ]) {
    const directory = join(scratch, checkout);
    for (const name of ["tools", "demo", "js"]) await mkdir(join(directory, name), { recursive: true });
    for (const name of [
      "tools/bundle.mjs",
      "tools/native-build.ts",
      "vite.config.ts",
      "package.json",
      "js/index.ts",
      "js/jsx-runtime.ts",
      "js/async-ownership.ts",
    ]) {
      await copyFile(join(render, name), join(directory, name));
    }
    await symlink(
      fileURLToPath(new URL("../../../node_modules", import.meta.url)),
      join(directory, "node_modules"),
      "dir",
    );
    const entry = join(directory, "demo/main.tsx");
    await copyFile(fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url)), entry);
    const run = () =>
      spawnSync(process.execPath, ["tools/bundle.mjs"], {
        cwd: directory,
        env: { ...process.env, NODE_ENV: "production" },
        encoding: "utf8",
        timeout: 30000,
      });
    const command = run();
    if (command.status !== 0 || command.error) {
      failures.push(
        `${checkout}: exit ${command.status}\n${command.error ?? ""}\n${command.stdout}\n${command.stderr}`,
      );
      continue;
    }
    const bundle = join(directory, "dist/demo.js");
    await assertOriginalMapping(
      bundle,
      entry,
      checkout === "typed"
        ? [
            ["initial", 'createSignal("initial")'],
            ["typed", '<p id="typed">'],
          ]
        : [
            ["increment", 'id="increment"'],
            ["editor", 'onFocus={() => setFocus("editor")}'],
          ],
    );
    await copyFile(bundle, join(output, result));
    assert((await readFile(join(output, result), "utf8")).length > 0);
    console.log(`${checkout}: production bundle + original TSX mappings passed`);

    // Real failures must reach the caller. A successful old output left on disk
    // must never hide a syntax or resolution error from the current invocation.
    for (const [source, diagnostic] of [
      ["export const broken: = <div />;", /Unexpected token|Expected|Parse|Syntax/i],
      ['import "./missing-build-dependency"; export const fixture = 1;', /missing-build-dependency/],
    ] as const) {
      await writeFile(entry, source);
      const rejected = run();
      assert(!rejected.error, String(rejected.error));
      assert.notEqual(rejected.status, 0, `${checkout}: production build swallowed error`);
      assert.match(`${rejected.stdout}\n${rejected.stderr}`, diagnostic);
    }

    if (checkout === "typed") {
      // Vite deliberately erases types. The separate checker must reject a
      // type-invalid TSX program which the production transpiler can bundle.
      await writeFile(
        entry,
        'import { mount } from "@tokamak/render";\nconst label: string = 42;\nmount(() => <p>{label}</p>);\n',
      );
      const transpiled = run();
      assert.equal(transpiled.status, 0, transpiled.stderr);
      await writeFile(
        join(directory, "tsconfig.json"),
        JSON.stringify({
          extends: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
          compilerOptions: { jsx: "preserve", jsxImportSource: "@tokamak/render", skipLibCheck: true },
          include: ["demo/**/*.tsx", "js/**/*.ts"],
        }),
      );
      const checked = spawnSync(process.execPath, ["check", "--no-script", "--project", "tsconfig.json"], {
        cwd: directory,
        encoding: "utf8",
        timeout: 30000,
      });
      assert(!checked.error, String(checked.error));
      assert.notEqual(checked.status, 0, "Explicit checker must reject invalid TSX types");
      assert.match(`${checked.stdout}\n${checked.stderr}`, /TS2322/);
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
