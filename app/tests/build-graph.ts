/** Feature boundaries must not silently pull database code into the desktop. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function dependencies(args: string[]) {
  const result = spawnSync("cargo", ["tree", "--locked", ...args,
    "--edges", "normal", "--prefix", "none", "--format", "{p}"],
    { encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const client = dependencies(["--package", "tokamak-app"]);
assert(!/^(server |surrealdb)/m.test(client), "desktop must not own a database/backend");
assert(/^engine /m.test(client), "client uses the common JavaScript engine");
const server = dependencies(["--package", "runtime", "--no-default-features", "--features", "server"]);
assert(!/^(render |blitz-|wgpu|winit |anyrender|vello)/m.test(server), "server-only runtime must not pull in GUI");
assert(/^server /m.test(server));
const engine = dependencies(["--package", "engine"]);
assert(!/^(server |surrealdb|render |blitz-|wgpu|winit )/m.test(engine));
console.log("PASS engine/runtime graphs: common engine, database-free client and GUI-free server");
