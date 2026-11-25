import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { test } from "bun:test";
import { build, built, workspace } from "./plugin-fixtures.mjs";
import { triggerFixtures } from "./trigger-fixtures.mjs";

const target = join(workspace, "target");
await mkdir(target, { recursive: true });
const fixture = async (options) => triggerFixtures(await mkdtemp(join(target, "trigger-build-")), options);

test("trigger types narrow document snapshots and use generated table IDs", async () => {
  const { owner, dependent } = await fixture();
  built(owner);
  built(dependent);
}, 45_000);

test("a trigger needs a declared dependency and an existing table", async () => {
  for (const [options, error] of [
    [{ depends: 'optional: ["owner"],' }, /Declare owner in depends to reference owner.items/],
    [{ table: "missing" }, /Property 'missing' does not exist on type '[^\n]*owner/],
  ]) {
    const { dependent } = await fixture(options);
    const result = build(dependent);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, error);
  }
}, 45_000);
