// Loader and query-cache races that need a precisely ordered interleaving: a
// reload notice landing mid-transfer, and a terminal subscription failure being
// replayed to a remounted view. Real windows cover the happy paths; these pin
// the ordering with controllable promises instead of timing.
import { test, expect } from "bun:test";
import { createPluginLoader } from "../js/plugins.ts";
import { ModuleRegistry } from "../js/modules.ts";
import { retainSubscriptions } from "../js/subscriptions.ts";

const catalogOf = (revision) => ({ revision, plugins: [], functions: [] });

function fakeAssets() {
  let listener;
  const transfers = [];
  return {
    assets: {
      // Each call is a transfer the test settles by hand.
      plugins: () => new Promise((resolve, reject) => transfers.push({ resolve, reject })),
      pluginAsset: async () => {
        throw new Error("no UI asset may be fetched");
      },
      onPluginsChanged(fn) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    },
    transfers,
    reloaded: (event) => listener(event),
  };
}

// Prevents a stale alert: the shell shows an alert when `connect()` rejects. If a
// reload lands while the first catalog transfer is in flight, that transfer's
// stale-page failure belongs to a superseded generation; the newer catalog
// fetch owns the outcome, so the old failure must not surface at all.
test("an initial catalog failure superseded by a reload is ignored", async () => {
  const { assets, transfers, reloaded } = fakeAssets();
  const loader = createPluginLoader(new ModuleRegistry(), assets);
  const connected = loader.connect();
  reloaded({ plugins: [], catalog: catalogOf("r2") });
  transfers[0].reject(new Error("Plugin generation changed"));
  await expect(connected).resolves.toBeUndefined();
  // The newer catalog, not the failed transfer, is what the shell shows.
  expect(loader.metadata().revision).toBe("r2");
});

// Companion to the above, so the guard cannot be "fixed" by swallowing every
// error: with no reload in between, the same failure must still reach the caller.
test("an initial catalog failure with no newer generation still rejects", async () => {
  const { assets, transfers } = fakeAssets();
  const loader = createPluginLoader(new ModuleRegistry(), assets);
  const connected = loader.connect();
  transfers[0].reject(new Error("Plugin generation changed"));
  await expect(connected).rejects.toThrow("Plugin generation changed");
});

// Prevents an older transfer that happens to succeed from overwriting the
// metadata the reload already published.
test("a superseded initial catalog success does not overwrite the newer catalog", async () => {
  const { assets, transfers, reloaded } = fakeAssets();
  const loader = createPluginLoader(new ModuleRegistry(), assets);
  const connected = loader.connect();
  reloaded({ plugins: [], catalog: catalogOf("r2") });
  transfers[0].resolve(catalogOf("r1"));
  await connected;
  expect(loader.metadata().revision).toBe("r2");
});

function fakeWire() {
  const subscriptions = [];
  return {
    subscriptions,
    transport: {
      query: async () => null,
      mutation: async () => null,
      subscribe(name, args, observer) {
        const subscription = { name, args, observer, stopped: 0 };
        subscriptions.push(subscription);
        return () => {
          subscription.stopped++;
        };
      },
    },
  };
}
const tooLarge = () => ({ error: new Error("result too large"), terminal: true });

// Prevents Reload replaying a dead subscription. A terminal failure (such as an
// oversized result) already released the wire subscription, so the window's
// query cache must forget the entry. If it keeps the cached error, a remounted
// view is handed that error again and never reaches the server.
test("a terminal subscription error evicts the entry so a remount subscribes again", () => {
  const wire = fakeWire(),
    cache = retainSubscriptions(wire.transport);
  const first = [],
    second = [];
  cache.subscribe("notes:list", {}, (event) => first.push(event));
  wire.subscriptions[0].observer(tooLarge());
  expect(first).toHaveLength(1);
  expect(first[0].error.message).toBe("result too large");
  // The failed view unmounts and its replacement mounts.
  cache.subscribe("notes:list", {}, (event) => second.push(event));
  expect(wire.subscriptions).toHaveLength(2);
  expect(second).toEqual([]);
  wire.subscriptions[1].observer({ value: [] });
  expect(second).toEqual([{ value: [] }]);
  cache.dispose();
});

// Companion: a failure that did NOT end the subscription (a rerun error) must
// keep sharing one wire subscription and replay its latest event, otherwise
// every remount would open another subscription.
test("a non-terminal error keeps the shared subscription and replays it", () => {
  const wire = fakeWire(),
    cache = retainSubscriptions(wire.transport);
  cache.subscribe("notes:list", {}, () => {});
  wire.subscriptions[0].observer({ error: new Error("rerun failed") });
  const replayed = [];
  cache.subscribe("notes:list", {}, (event) => replayed.push(event));
  expect(wire.subscriptions).toHaveLength(1);
  expect(replayed[0].error.message).toBe("rerun failed");
  cache.dispose();
});

// Prevents a dead entry when the terminal event is delivered synchronously from
// inside `transport.subscribe` (a connection that is already closed). The entry
// must exist before the call, or the eviction runs too early and the stale
// entry is stored afterwards.
test("a terminal error delivered during subscribe still evicts the entry", () => {
  const wire = fakeWire();
  const closed = {
    ...wire.transport,
    subscribe(name, args, observer) {
      observer(tooLarge());
      return wire.transport.subscribe(name, args, observer);
    },
  };
  const cache = retainSubscriptions(closed);
  cache.subscribe("notes:list", {}, () => {});
  cache.subscribe("notes:list", {}, () => {});
  expect(wire.subscriptions).toHaveLength(2);
  cache.dispose();
});

// Actions must pass through the window cache to the same connected transport.
test("the window query cache preserves action support and results", async () => {
  const wire = fakeWire();
  expect(retainSubscriptions(wire.transport).action).toBeUndefined();
  const calls = [];
  wire.transport.action = async (name, args) => {
    calls.push({ name, args });
    return { status: "done" };
  };
  const cache = retainSubscriptions(wire.transport);
  expect(await cache.action("chat/chat:send", { threadId: "one", text: "hello" })).toEqual({
    status: "done",
  });
  expect(calls).toEqual([{ name: "chat/chat:send", args: { threadId: "one", text: "hello" } }]);
  cache.dispose();
});
