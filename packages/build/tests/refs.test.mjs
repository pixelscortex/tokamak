import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "bun:test";
import { build, built, workspace } from "./plugin-fixtures.mjs";
import { ownerSchema, refFixtures } from "./ref-fixtures.mjs";

const target = join(workspace, "target");
await mkdir(target, { recursive: true });
const fixture = async (options) => refFixtures(await mkdtemp(join(target, "refs-build-")), options);

test("ref types are inferred and refreshed from the owner's schema on every build", async () => {
  const { owner, dependent } = await fixture();
  built(owner);
  built(dependent);

  const copy = join(dependent, ".tokamak/types/owner/tables.d.ts");
  const before = await readFile(copy, "utf8");
  assert.match(before, /TableReference<"owner.items".*"label": string/);
  assert.doesNotMatch(before, /"rank"/);

  await writeFile(join(owner, "src/schema.ts"), ownerSchema("rank: v.optional(v.number())"));
  built(owner);
  built(dependent);
  assert.match(await readFile(copy, "utf8"), /TableReference<"owner.items".*"rank"\?: number/);
}, 45_000);

test("refs require a declared dependency and a real table", async () => {
  for (const [options, error] of [
    [{ depends: 'optional: ["owner"],' }, /Declare owner in depends to reference owner.items/],
    [{ table: "missing" }, /Property 'missing'.*owner/s],
  ]) {
    const { dependent } = await fixture(options);
    const result = build(dependent);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, error);
  }
}, 45_000);
