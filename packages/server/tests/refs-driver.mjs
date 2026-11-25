import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { connect, startServer } from "../../../e2e/fake-agent/harness.mjs";
import { built, workspace } from "../../build/tests/plugin-fixtures.mjs";
import { refFixtures } from "../../build/tests/ref-fixtures.mjs";
import { createApi } from "../../sdk/src/index.ts";

const target = join(workspace, "packages/server/target");
await mkdir(target, { recursive: true });
const scratch = await mkdtemp(join(target, "refs-runtime-"));
const { owner, dependent } = await refFixtures(join(scratch, "sources"));
const pluginsDir = join(scratch, "installed");
for (const [id, source] of [
  ["owner", owner],
  ["dependent", dependent],
]) {
  built(source);
  await cp(join(source, "dist"), join(pluginsDir, id), { recursive: true });
}

const servers = [];
const cleanup = [];
try {
  const address = await startServer({
    binary: process.argv[2],
    dir: join(scratch, "server"),
    pluginsDir,
    servers,
    cleanup,
  });
  const client = await connect(address, { cleanup });
  const items = createApi("owner").rows;
  const links = createApi("dependent").rows;

  const { item: id, other } = await client.mutation(items.add, {});
  const { item: unrelated } = await client.mutation(items.add, {});
  await assert.rejects(client.mutation(links.add, { id: other }), /id of the declared table/);
  await assert.rejects(client.mutation(links.add, { id: "owner/items:missing" }), /does not exist/);
  const first = await client.mutation(links.add, { id });
  const second = await client.mutation(links.add, { id });
  const kept = await client.mutation(links.add, { id: unrelated });

  const linked = async (id) => (await client.query(links.byItem, { id })).map((row) => row._id).sort();
  assert.deepEqual(await linked(id), [first, second].sort());
  await assert.rejects(client.query(links.byItem, { id: other }), /id of table owner.items/);
  assert.deepEqual(await client.query(links.localItems, {}), []);
  await assert.rejects(client.query(links.foreignRead, { id }), /does not own that record/);
  await assert.rejects(client.mutation(links.foreignWrite, { id }), /does not own that record/);

  const ownerIds = async () => (await client.query(items.list, {})).map((row) => row._id).sort();
  assert.deepEqual(await client.mutation(items.remove, { id, undo: true }), {
    failed: true,
    kind: "undo",
    data: null,
  });
  assert.deepEqual(await ownerIds(), [id, unrelated].sort());
  assert.deepEqual(await linked(id), [first, second].sort());

  await client.mutation(items.remove, { id, undo: false });
  assert.deepEqual(await ownerIds(), [unrelated]);
  assert.deepEqual(await linked(id), []);
  assert.deepEqual(await linked(unrelated), [kept]);
} finally {
  for (const close of cleanup.reverse()) await close();
  for (const server of servers) {
    server.kill("SIGTERM");
    await server.exited;
  }
}
