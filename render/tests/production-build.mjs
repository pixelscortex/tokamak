// Run the production script byte-for-byte in isolated package checkouts. This
// deliberately has no Babel/plugin implementation: changes to the real bundler
// must fix both ordinary TSX parsing and URL decoding of checkout paths.
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const render = fileURLToPath(new URL("../", import.meta.url));
const output = join(render, "dist", "tests");

await mkdir(output, { recursive: true });

const scratch = await mkdtemp(join(output, "production-build-"));
const failures = [];

try {
  for (const [checkout, fixture, result] of [
    ["typed", "typed-component.tsx", "production-typed.js"],
    ["checkout with spaces", "../../demo/main.tsx", "production-spaces.js"],
  ]) {
    const directory = join(scratch, checkout);

    for (const name of ["tools", "demo", "js"])
      await mkdir(join(directory, name), { recursive: true });

    for (const name of [
      "tools/bundle.mjs",
      "tools/transform.mjs",
      "package.json",
      "js/index.ts",
      "js/jsx-runtime.ts",
    ]) {
      await copyFile(join(render, name), join(directory, name));
    }
    await symlink(
      fileURLToPath(new URL("../../node_modules", import.meta.url)),
      join(directory, "node_modules"),
      "dir",
    );
    await copyFile(
      fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url)),
      join(directory, "demo/main.tsx"),
    );
    const command = spawnSync(process.execPath, ["tools/bundle.mjs"], {
      cwd: directory,
      env: { ...process.env, NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 30000,
    });

    if (command.status !== 0 || command.error) {
      failures.push(
        `${checkout}: exit ${command.status}\n${command.error ?? ""}\n${command.stdout}\n${command.stderr}`,
      );
    } else {
      await copyFile(join(directory, "dist/demo.js"), join(output, result));
      assert((await readFile(join(output, result), "utf8")).length > 0);
      console.log(`${checkout}: production bundle passed`);
    }
  }

  assert.equal(failures.length, 0, failures.join("\n"));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
