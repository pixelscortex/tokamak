/** Build the small record fixture in standalone mode for raw-bundle/native
 * regressions. The installed artifact itself always uses the shared shell. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = resolve(root, "app/dist/tests/record");
await mkdir(fixture, { recursive: true });
for (const directory of ["src", "backend"])
  await cp(resolve(root, `app/tests/fixtures/record/${directory}`), resolve(fixture, directory), {
    recursive: true,
    filter: (path) => !/\/(dist|_generated)(\/|$)/.test(path),
  });
await copyFile(resolve(root, "app/tests/fixtures/record-main.tsx"), resolve(fixture, "src/main.tsx"));
await writeFile(resolve(fixture, "package.json"), JSON.stringify({ name: "test-record", type: "module" }));
await writeFile(
  resolve(fixture, "tsconfig.json"),
  JSON.stringify({
    extends: resolve(root, "app/tsconfig.json"),
    include: ["src", "backend"],
    exclude: ["backend/dist"],
  }),
);
await writeFile(
  resolve(fixture, "backend/tsconfig.json"),
  JSON.stringify({
    extends: resolve(root, "app/backend/tsconfig.json"),
    include: ["**/*.ts"],
    exclude: ["dist"],
  }),
);
await writeFile(
  resolve(fixture, "vite.config.ts"),
  'import {tokamak} from "@tokamak/build/vite"; export default {plugins:[tokamak({standalone:true})]};\n',
);
const result = spawnSync(process.execPath, [resolve(root, "packages/build/src/build.ts"), fixture], {
  stdio: "inherit",
  timeout: 30_000,
});
assert.ifError(result.error);
assert.equal(result.status, 0, "standalone Record compatibility build");

const installed = spawnSync(
  process.execPath,
  [resolve(root, "packages/build/src/build.ts"), resolve(root, "app/tests/fixtures/record")],
  { stdio: "inherit" },
);
assert.equal(installed.status, 0);
