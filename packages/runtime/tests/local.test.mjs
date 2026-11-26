import { fail } from "../../sdk/src/functions.ts";
import { expect, test } from "bun:test";
import { createApi, TokamakClient } from "../../sdk/src/index.ts";
import { LocalFunctions } from "../js/local.ts";

function routeAction(artifactCode) {
  return async (name) => {
    const id = name.split("/")[0];
    return {
      destination: "callerWindowRunner",
      note: { depth: 0, thread: null },
      artifact: { id, entryHash: "entry", codeHash: artifactCode(id) },
    };
  };
}

test("only a changed or removed local artifact retires its running worker", async () => {
  const artifact = (id, code) => ({
    plugin: { id },
    entries: { local: { entry: "entry", code: "code" } },
    hashes: { entry: "entry", code },
  });
  const alpha = artifact("alpha", "alpha-v1");
  const beta = artifact("beta", "beta-v1");
  let catalog = { plugins: [alpha, beta] };
  let notify;
  const server = {
    dispatchWindowAction: routeAction((id) => catalog.plugins.find((p) => p.plugin.id === id)?.hashes.code),
    plugins: async () => catalog,
    onPluginsChanged(listener) {
      notify = listener;
      return () => {};
    },
  };
  const launches = [];
  const sent = Promise.withResolvers();
  const functions = new LocalFunctions(server, async ({ id }, receive, closed) => {
    let request;
    const worker = {
      id,
      closed: false,
      async send(message) {
        request = message;
        if (launches.filter((item) => item.ready()).length === 2) sent.resolve();
      },
      async retire(artifact) {
        if (artifact.id === id) closed("Local plugin build retired");
      },
      ready: () => !!request,
      finish: () => receive({ type: "result", id: request.id, value: id }),
      async close() {
        worker.closed = true;
      },
    };
    launches.push(worker);
    return worker;
  });
  const client = new TokamakClient(server, functions);
  const a = createApi("alpha");
  const b = createApi("beta");
  try {
    const runningA = client.action(a.jobs.run, {});
    const runningB = client.action(b.jobs.run, {});
    void runningA.catch(() => {});
    void runningB.catch(() => {});
    await sent.promise;
    catalog = { plugins: [alpha, artifact("beta", "beta-v2")] };
    notify({ type: "pluginchanged", plugins: [], catalog: { paged: true } });
    await expect(runningB).rejects.toThrow("retired");
    const stillRunning = launches.find((worker) => worker.id === "alpha");
    expect(stillRunning.closed).toBe(false);
    stillRunning.finish();
    await expect(runningA).resolves.toBe("alpha");

    catalog = { plugins: [] };
    notify({ type: "pluginchanged", plugins: ["alpha"], catalog: { paged: true } });
    await expect(client.action(a.jobs.run, {})).resolves.toEqual(fail("noMachine", null));
    expect(stillRunning.closed).toBe(true);
  } finally {
    await functions.close();
  }
});

test("many local calls at once read the plugin catalog once, and again only after it changes", async () => {
  const alpha = {
    plugin: { id: "alpha" },
    entries: { local: { entry: "entry", code: "code" } },
    hashes: { entry: "entry", code: "alpha-v1" },
  };
  let reads = 0;
  let notify;
  const server = {
    dispatchWindowAction: routeAction(() => "alpha-v1"),
    plugins: async () => {
      reads += 1;
      return { plugins: [alpha] };
    },
    onPluginsChanged(listener) {
      notify = listener;
      return () => {};
    },
  };
  const functions = new LocalFunctions(server, async (_artifact, receive) => ({
    async send(message) {
      receive({ type: "result", id: message.id, value: "done" });
    },
    async retire() {},
    async close() {},
  }));
  const client = new TokamakClient(server, functions);
  const a = createApi("alpha");
  try {
    const results = await Promise.all(Array.from({ length: 40 }, () => client.action(a.jobs.run, {})));
    expect(results.every((value) => value === "done")).toBe(true);
    expect(reads).toBe(1);
    await client.action(a.jobs.run, {});
    expect(reads).toBe(1);
    notify({ type: "pluginchanged", plugins: ["alpha"], catalog: { paged: true } });
    await client.action(a.jobs.run, {});
    expect(reads).toBeGreaterThan(1);
  } finally {
    await functions.close();
  }
});

test("a plugin installed before its notice arrives is found, and a missing one costs one extra catalog read", async () => {
  const alpha = {
    plugin: { id: "alpha" },
    entries: { local: { entry: "entry", code: "code" } },
    hashes: { entry: "entry", code: "alpha-v1" },
  };
  let catalog = { plugins: [] };
  let reads = 0;
  const server = {
    dispatchWindowAction: routeAction(() => "alpha-v1"),
    plugins: async () => {
      reads++;
      return catalog;
    },
    onPluginsChanged: () => () => {},
  };
  const functions = new LocalFunctions(server, async ({ id }, receive) => ({
    async send(message) {
      receive({ type: "result", id: message.id, value: id });
    },
    async retire() {},
    async close() {},
  }));
  const client = new TokamakClient(server, functions);
  const a = createApi("alpha");
  const missing = createApi("missing");
  try {
    // The catalog is read while alpha is not installed yet.
    await expect(client.action(missing.jobs.run, {})).resolves.toEqual(fail("noMachine", null));
    const afterFirstMiss = reads;
    // Asking again for a plugin that is not there reads nothing more.
    await expect(client.action(missing.jobs.run, {})).resolves.toEqual(fail("noMachine", null));
    expect(reads).toBe(afterFirstMiss);

    // alpha is installed; no "plugins changed" notice has reached this connection.
    catalog = { plugins: [alpha] };
    await expect(client.action(a.jobs.run, {})).resolves.toBe("alpha");
    expect(reads).toBe(afterFirstMiss + 1);
  } finally {
    await functions.close();
  }
});

test("window server actions do not need the plugin catalog", async () => {
  let reads = 0;
  const server = {
    async plugins() {
      reads++;
      throw new Error("catalog unavailable");
    },
    async dispatchWindowAction(_name, _args, on) {
      return { destination: "result", value: on ?? "server" };
    },
    onPluginsChanged: () => () => {},
  };
  const local = new LocalFunctions(server, async () => {
    throw new Error("unexpected Runner launch");
  });
  try {
    expect(await local.action("fixture/run:work", {}, { on: "server" })).toBe("server");
    expect(await local.action("fixture/run:work", {})).toBe("server");
    expect(reads).toBe(0);
  } finally {
    await local.close();
  }
});

test("an old window bundle gets a migration error from the former local entry point", async () => {
  const functions = new LocalFunctions({
    onPluginsChanged: () => () => {},
  });
  try {
    await expect(functions.invoke("alpha/jobs.run", {})).rejects.toThrow(
      'local() was removed: rebuild the plugin with action({ on: "caller" })',
    );
  } finally {
    await functions.close();
  }
});
