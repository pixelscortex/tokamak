import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, startServer } from "../../../e2e/fake-agent/harness.mjs";
import { built, workspace } from "../../build/tests/plugin-fixtures.mjs";
import { triggerFixtures } from "../../build/tests/trigger-fixtures.mjs";
import { createApi } from "../../sdk/src/index.ts";

async function benchmark(client, triggers) {
  const cases = [triggers.savePlain, triggers.saveNoop, triggers.saveWrite];
  const times = cases.map(() => []);
  const warmup = 30;
  const samples = 201;
  for (let lap = 0; lap < warmup + samples; lap++) {
    for (let step = 0; step < cases.length; step++) {
      const index = (lap + step) % cases.length;
      const start = performance.now();
      await client.mutation(cases[index], {});
      if (lap >= warmup) times[index].push(performance.now() - start);
    }
  }
  const ms = times.map((set) => set.sort((a, b) => a - b)[Math.floor(samples / 2)]);
  console.log({ samples, warmup, medianMilliseconds: { plain: ms[0], noop: ms[1], write: ms[2] } });
}

const target = join(workspace, "packages/server/target");
await mkdir(target, { recursive: true });
const scratch = await mkdtemp(join(target, "trigger-runtime-"));
const fixtures = await triggerFixtures(join(scratch, "sources"));
const pluginsDir = join(scratch, "installed");
for (const [id, source] of Object.entries(fixtures)) {
  built(source);
  await cp(join(source, "dist"), join(pluginsDir, id), { recursive: true });
}

const servers = [];
const cleanup = [];
const token = "a".repeat(64);
const localDir = join(scratch, "local");
await mkdir(localDir);
await writeFile(join(localDir, "server.token"), token, { mode: 0o600 });
try {
  const address = await startServer({
    binary: process.argv[2],
    dir: join(scratch, "server"),
    pluginsDir,
    servers,
    cleanup,
    localDir,
  });
  const client = await connect(address, { cleanup, token });
  const http = new URL(address);
  http.protocol = "http:";
  http.pathname = "/plugins";
  const headers = { authorization: `Bearer ${token}` };
  const catalog = async () => {
    const response = await fetch(http, { headers });
    assert.ok(response.ok);
    return response.json();
  };
  const owner = createApi("owner");
  const dependent = createApi("dependent").rows;
  const rows = owner.rows;
  const triggers = owner.triggers;

  if (process.argv.includes("--benchmark")) {
    await benchmark(client, triggers);
  } else {
    const save = (label, path = "direct") => client.mutation(triggers.save, { label, path });
    const events = () => client.query(dependent.events, {});
    const allRows = () => client.query(rows.list, {});
    const list = await catalog();
    assert.deepEqual(list.triggers["owner.items"], [
      { plugin: "dependent", name: "rows:track" },
      { plugin: "dependent", name: "rows:observe" },
    ]);

    const id = await save("window");
    const viaPlugin = await client.mutation(dependent.addViaPlugin, { label: "plugin" });
    const internal = await save("internal", "internal");
    await client.mutation(triggers.update, { id, label: "patched", replace: false });
    await client.mutation(triggers.update, { id, label: "replaced", replace: true });
    await client.mutation(triggers.update, { id, label: "replaced", replace: true });
    const link = await client.mutation(dependent.link, { id });
    await client.mutation(rows.remove, { id, undo: false });

    const history = await events();
    const stamp = history.find((event) => event.row === id && event.op === "insert").after._creationTime;
    const doc = (label) => ({ _id: id, _creationTime: stamp, label });
    const assertChange = (op, before, after) => {
      const matches = history.filter(
        (event) =>
          event.row === id &&
          event.op === op &&
          event.before?.label === before?.label &&
          event.after?.label === after?.label,
      );
      assert.equal(matches.length, 1);
      assert.deepEqual(matches[0].before, before);
      assert.deepEqual(matches[0].after, after);
      assert.equal(matches[0].depth, 1);
      assert.ok(matches[0].user);
      return matches[0].user;
    };
    const user = assertChange("insert", null, doc("window"));
    assertChange("update", doc("window"), doc("patched"));
    assertChange("update", doc("patched"), doc("replaced"));
    assertChange("delete", doc("replaced"), null);
    for (const [row, label] of [
      [viaPlugin, "plugin"],
      [internal, "internal"],
    ]) {
      const event = history.find((entry) => entry.row === row);
      assert.equal(event.after.label, label);
      assert.equal(event.depth, 2);
      assert.equal(event.user, user);
    }
    assert.equal(history.length, 7);
    const cascade = history.find((event) => event.row === link);
    assert.deepEqual([cascade.op, cascade.before.item, cascade.after], ["delete", id, null]);
    assert.deepEqual(await client.query(dependent.links, {}), []);

    await assert.rejects(save("rollback", "rollback"), /owner failed after write/);
    for (const path of ["direct", "catch"]) {
      await assert.rejects(save("throw", path), (error) => {
        assert.equal(error.plugin, "dependent");
        assert.equal(error.stage, "trigger");
        assert.equal(error.table, "owner.items");
        assert.equal(error.kind, "triggerException");
        assert.match(
          error.message,
          /trigger refused the row.*dependent\/rows:track, dependent\/rows:observe/,
        );
        return true;
      });
    }
    await assert.rejects(save("foreign"), /does not own that record/);
    assert.deepEqual((await allRows()).map((row) => row.label).sort(), ["internal", "plugin"]);
    assert.deepEqual(await events(), history);

    await assert.rejects(client.mutation(triggers.startLoop, {}), (error) => {
      assert.equal(error.kind, "triggerDepthLimit");
      assert.equal(error.stage, "trigger");
      assert.ok(["owner", "dependent"].includes(error.plugin));
      assert.match(error.table, /^owner\.loop[AB]$/);
      return true;
    });
    assert.equal(await client.query(triggers.loops, {}), 0);

    await rename(join(pluginsDir, "dependent"), join(scratch, "uninstalled"));
    const reloaded = await fetch(new URL("/plugins/dependent/reload", http), { method: "POST", headers });
    assert.ok(reloaded.ok, await reloaded.text());
    assert.equal((await catalog()).triggers["owner.items"], undefined);
    await save("throw");
  }
} finally {
  for (const close of cleanup.reverse()) await close();
  for (const server of servers) {
    server.kill("SIGTERM");
    await server.exited;
  }
}
