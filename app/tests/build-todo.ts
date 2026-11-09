/** Exercise the maintained Todo source in standalone mode for raw-bundle/native
 * regressions. The installed artifact itself always uses the shared shell. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = resolve(root, "app/dist/tests/todo");
await mkdir(fixture, { recursive: true });
for (const directory of ["src", "backend"]) await cp(resolve(root, `plugins/todo/${directory}`), resolve(fixture, directory), { recursive: true, filter: path => !/\/(dist|_generated)(\/|$)/.test(path) });
await copyFile(resolve(root, "app/tests/fixtures/todo-main.tsx"), resolve(fixture, "src/main.tsx"));
const todos = resolve(fixture, "src/todos.tsx");
await writeFile(todos, (await readFile(todos, "utf8")).replace("backend/_generated/api", "backend/_legacyApi"));
await writeFile(resolve(fixture, "package.json"), JSON.stringify({ name: "test-todo", type: "module" }));
await writeFile(resolve(fixture, "tsconfig.json"), JSON.stringify({ extends: resolve(root, "app/tsconfig.json"), include: ["src", "backend"], exclude: ["backend/dist"] }));
await writeFile(resolve(fixture, "backend/tsconfig.json"), JSON.stringify({ extends: resolve(root, "app/backend/tsconfig.json"), include: ["**/*.ts"], exclude: ["dist"] }));
await writeFile(resolve(fixture, "vite.config.ts"), 'import {tokamak} from "@tokamak/build/vite"; export default {plugins:[tokamak({standalone:true})]};\n');
const result = spawnSync(process.execPath, [resolve(root, "packages/build/src/build.ts"), fixture], { stdio: "inherit", timeout: 30_000 });
assert.ifError(result.error);
assert.equal(result.status, 0, "standalone Todo compatibility build");
