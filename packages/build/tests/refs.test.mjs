import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
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
  assert.match(before, /"parent"\?: Id<"owner.folders">/);
  assert.doesNotMatch(before, /"rank"/);

  await writeFile(join(owner, "src/schema.ts"), ownerSchema("rank: v.optional(v.number())"));
  built(owner);
  built(dependent);
  assert.match(await readFile(copy, "utf8"), /TableReference<"owner.items".*"rank"\?: number/);
}, 45_000);

test("refs require a declared dependency and a real table", async () => {
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

test("defineTable rejects refs nested in arrays, objects and unions", async () => {
  const { dependent } = await fixture();
  await writeFile(
    join(dependent, "src/schema.ts"),
    `
    import { defineTable, defineSchema, v } from "@tokamak/sdk";
    import { tables } from "plugin:owner/tables";
    const ref = v.ref(tables.items);
    export default defineSchema({ links: defineTable({
      item: v.array(ref),
      object: v.object({ item: ref }),
      union: v.optional(v.union(v.string(), ref)),
    }) });
  `,
  );
  const result = build(dependent);
  assert.notEqual(result.status, 0);
  assert.equal(
    result.stdout.match(/^schema\.ts[^\n]*error TS[^\n]*A ref must be a top-level field/gm)?.length,
    3,
  );
}, 30_000);

test("Vite's plugin option supplies dependencies for table imports", async () => {
  const { dependent } = await fixture();
  await unlink(join(dependent, "plugin.ts"));
  await writeFile(
    join(dependent, "vite.config.ts"),
    `import { tokamak } from ${JSON.stringify(join(workspace, "packages/build/src/vite.ts"))};
     export default { plugins: [tokamak({
       plugin: { id: "dependent", version: "1.0.0", depends: { owner: "*" } },
     })] };`,
  );
  built(dependent);
  const manifest = JSON.parse(await readFile(join(dependent, "dist/manifest.json"), "utf8"));
  assert.deepEqual(manifest.plugin.depends, { owner: "*" });
}, 30_000);
