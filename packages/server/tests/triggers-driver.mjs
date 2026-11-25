import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, startServer } from "../../../e2e/fake-agent/harness.mjs";
import { built, workspace } from "../../build/tests/plugin-fixtures.mjs";
import { triggerFixtures } from "../../build/tests/trigger-fixtures.mjs";
import { createApi } from "../../sdk/src/index.ts";

async function benchmark(baseline, client, triggers) {
  const cases = [
    ["baseline", baseline, triggers.savePlain],
    ["unwatched", client, triggers.savePlain],
    ["ownNoop", client, triggers.saveNoop],
    ["ownWrite", client, triggers.saveWrite],
    ["crossWrite", client, triggers.saveCross],
  ];
  const times = cases.map(() => []);
  const warmup = 30;
  const samples = 201;
  for (let lap = 0; lap < warmup + samples; lap++) {
    for (let step = 0; step < cases.length; step++) {
      const index = (lap + step) % cases.length;
      const [, connection, mutation] = cases[index];
      const start = performance.now();
      await connection.mutation(mutation, {});
      if (lap >= warmup) times[index].push(performance.now() - start);
    }
  }
  const median = (set) => set.sort((a, b) => a - b)[Math.floor(set.length / 2)];
  const bulkTimes = [[], []];
  for (let lap = 0; lap < 13; lap++) {
    for (const [index, connection] of [baseline, client].entries()) {
      const start = performance.now();
      await connection.mutation(triggers.bulk, {});
      if (lap >= 2) bulkTimes[index].push(performance.now() - start);
    }
  }
  const [bulkBaseline, bulkWatched] = bulkTimes.map(median);
  console.log({
    samples,
    warmup,
    medianMilliseconds: Object.fromEntries(cases.map(([name], i) => [name, median(times[i])])),
    bulk300: {
      samples: 11,
      warmup: 2,
      baseline: bulkBaseline,
      watched: bulkWatched,
      addedPerRow: (bulkWatched - bulkBaseline) / 300,
    },
  });
}

const target = join(workspace, "packages/server/target");
await mkdir(target, { recursive: true });
const scratch = await mkdtemp(join(target, "trigger-runtime-"));
const fixtures = await triggerFixtures(join(scratch, "sources"), { chain: true });
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
    const { owner: plain } = await triggerFixtures(join(scratch, "baseline-sources"), { ownerStages: false });
    built(plain);
    const baselinePlugins = join(scratch, "baseline-plugins");
    await cp(join(plain, "dist"), join(baselinePlugins, "owner"), { recursive: true });
    const baselineAddress = await startServer({
      binary: process.argv[2],
      dir: join(scratch, "baseline-server"),
      pluginsDir: baselinePlugins,
      servers,
      cleanup,
    });
    const baseline = await connect(baselineAddress, { cleanup });
    await benchmark(baseline, client, triggers);
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
    const action = await client.action(triggers.saveFromAction, {});
    const leaf = createApi("leaf");

    await client.mutation(triggers.update, { id, label: "patched", replace: false });
    await client.mutation(triggers.update, { id, label: "replaced", replace: true });
    await client.mutation(triggers.update, { id, label: "replaced", replace: true });
    const link = await client.mutation(dependent.link, { id });
    const grandchild = await client.mutation(leaf.rows.add, { link });
    await client.mutation(rows.remove, { id, undo: false });
    assert.deepEqual(
      (await client.query(leaf.audit.events, {})).map((event) => event.row),
      [grandchild],
    );

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
    assert.equal(history.find((event) => event.row === action).after.label, "action");
    assert.equal(history.length, 8);
    const cascade = history.find((event) => event.row === link);
    assert.deepEqual([cascade.op, cascade.before.item, cascade.after], ["delete", id, null]);
    assert.deepEqual(await client.query(dependent.links, {}), []);

    await assert.rejects(save("rollback", "rollback"), /owner failed after write/);
    for (const path of ["direct", "catch", "nestedCatch"]) {
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
    for (const label of ["foreign", "foreign-patch"]) {
      await assert.rejects(save(label), /does not own that record/);
    }
    await assert.rejects(save("foreign-insert"), { plugin: "dependent", kind: "triggerException" });
    assert.deepEqual((await allRows()).map((row) => row.label).sort(), ["action", "internal", "plugin"]);
    assert.deepEqual(await events(), history);

    await assert.rejects(client.mutation(triggers.startLoop, {}), (error) => {
      assert.equal(error.kind, "triggerDepthLimit");
      assert.equal(error.stage, "trigger");
      assert.ok(["owner", "dependent"].includes(error.plugin));
      assert.match(error.table, /^owner\.loop[AB]$/);
      return true;
    });
    assert.equal(await client.query(triggers.loops, {}), 0);

    await assert.rejects(client.mutation(triggers.startSelf, {}), {
      plugin: "owner",
      table: "owner.selfLoop",
      kind: "triggerDepthLimit",
    });
    await assert.rejects(save("fanout"), {
      plugin: "dependent",
      table: "owner.items",
      kind: "triggerBudgetLimit",
    });
    await client.mutation(triggers.bulk, {});
    assert.equal((await events()).filter((event) => event.after?.label === "bulk").length, 300);

    const parent = await save("cascade");
    await client.mutation(dependent.linkBulk, { id: parent });
    await client.mutation(rows.remove, { id: parent, undo: false });
    assert.equal(
      (await events()).filter((event) => event.op === "delete" && event.before?.item === parent).length,
      300,
    );
    assert.deepEqual(await client.query(dependent.links, {}), []);

    await rename(join(pluginsDir, "leaf"), join(scratch, "uninstalled-leaf"));
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
