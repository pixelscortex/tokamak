/** Clean-checkout regression: native UI tests load ui/dist/styles.css. Their
 * task must declare its producer, rather than pass only after a prior UI build.
 * Inspect Moon's resolved dependency graph so inherited/transitive prerequisites
 * count too; no generated artifact or shared checkout needs to be deleted. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

interface Task {
  deps?: { target: string }[];
}

test("render:test declares the UI stylesheet build as a prerequisite", () => {
  const visited = new Set<string>();
  function reachesUiBuild(target: string): boolean {
    if (target === "ui:build") return true;
    if (visited.has(target)) return false;
    visited.add(target);
    const result = spawnSync("moon", ["task", target, "--json"], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      timeout: 15000,
    });
    assert(!result.error, String(result.error));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const task = JSON.parse(result.stdout) as Task;
    return (task.deps ?? []).some(({ target: dependency }) => reachesUiBuild(dependency));
  }
  assert(
    reachesUiBuild("render:test"),
    "render:test must depend on ui:build (directly or transitively) before its native fixture reads ui/dist/styles.css in a clean checkout",
  );
});
