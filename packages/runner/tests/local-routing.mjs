import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, connect, within, workspace } from "../../../e2e/fake-agent/harness.mjs";
import { startRunner } from "../../../e2e/fake-agent/start-runner.ts";
import { authCaller, createApi } from "../../sdk/src/index.ts";
import { editBundle, inspectHosts, installLocal, rawWindow, reload, until } from "./support/routing.mjs";

const binary = process.argv[2];
const scratch = await mkdtemp(join(workspace, "target/local-routing-"));
const plugins = join(scratch, "plugins");
const directory = join(scratch, "runner");
const owner = "routed-owner";
const alpha = "routed-alpha";
const beta = "routed-beta";
const crash = "routed-crash";

async function plugin(id, source, contract = "") {
  const root = join(plugins, id);
  await mkdir(join(root, "src/server"), { recursive: true });
  await symlink(join(workspace, "app/node_modules"), join(root, "node_modules"), "dir");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: id, type: "module" }));
  await writeFile(
    join(root, "plugin.ts"),
    `
    import { definePlugin } from "@tokamak/sdk";
    export default definePlugin(${JSON.stringify({
      id,
      version: "1.0.0",
      ...(id !== owner ? { depends: [owner] } : {}),
    })});
  `,
  );
  if (contract) await writeFile(join(root, "src/contracts.ts"), contract);
  await writeFile(join(root, "src/server/probe.ts"), source);
  build(root);
}

await plugin(
  owner,
  `
  /// <reference types="node" />
  import { readFile } from "node:fs/promises";
  import { local, provide, v } from "@tokamak/sdk";
  import { probe, ownProbe } from "../contracts";
  export const selfProvider = provide(ownProbe, { echo: async (value) => value });
  export const selfCall = local({
    args: { invalid: v.boolean() },
    handler: (ctx, { invalid }) => ownProbe.get("${owner}", ctx).echo(invalid ? new Date() : { ok: true }),
  });
  export const identify = local({
    args: { id: v.string() },
    handler: (ctx, { id }) => probe.get(id, ctx).identify(),
  });
  export const hold = local({
    args: { id: v.string(), path: v.string(), cancelCall: v.optional(v.boolean()) },
    handler: async (ctx, { id, path, cancelCall }) => {
      if (!cancelCall) return probe.get(id, ctx, { signal: ctx.signal }).hold({ path, signal: ctx.signal });
      const controller = new AbortController();
      const timer = setInterval(() => {
        void readFile(path + ".stop").then(() => controller.abort(), () => {});
      }, 20);
      try {
        await probe.get(id, ctx, { signal: controller.signal }).hold({ path, signal: controller.signal });
        throw new Error("Expected the routed call to be cancelled");
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Local contract call cancelled") throw error;
        return await probe.get(id, ctx).identify();
      } finally {
        clearInterval(timer);
      }
    },
  });
  export const badArgs = local({
    handler: (ctx) => probe.get("custom-alpha", ctx, { signal: ctx.signal })
      .hold({ path: (() => {}) as unknown as string, signal: ctx.signal }),
  });
  const nested = () => Array.from({ length: 140 }).reduce((value) => [value], null as unknown);
  export const badResult = local({ handler: (ctx) => probe.get("custom-alpha", ctx).badResult() });
  export const deepArgs = local({ handler: (ctx) => probe.get("custom-alpha", ctx).echo(nested()) });
  export const largeArgs = local({ handler: (ctx) => probe.get("custom-alpha", ctx).echo("🙂".repeat(300_000)) });
  export const deepResult = local({ handler: (ctx) => probe.get("custom-alpha", ctx).deepResult() });
  export const largeResult = local({ handler: (ctx) => probe.get("custom-alpha", ctx).largeResult() });
  export const thrown = local({ handler: (ctx) => probe.get("custom-alpha", ctx).thrown() });
  export const checkBad = local({ handler: (ctx) => probe.get("custom-crash", ctx).identify() });
  export const cancelBurst = local({
    handler: async (ctx) => {
      for (let batch = 0; batch < 4; batch++) {
        const controller = new AbortController();
        const providers = await probe.list(ctx, { signal: controller.signal });
        const provider = providers.find(({ id }) => id === "custom-alpha")!;
        const attempts = Array.from({ length: 128 }, (_, id) => provider.echo(id));
        controller.abort();
        const cancelled = await Promise.allSettled(attempts);
        if (cancelled.some((result) => result.status !== "rejected" ||
            result.reason.message !== "Local contract call cancelled"))
          throw new Error("Expected every queued call in the burst to cancel");
      }
      return probe.get("custom-alpha", ctx).identify();
    },
  });
  export const list = local({ handler: async (ctx) => (await probe.list(ctx)).map(({ id }) => id) });
  export const unavailable = local({
    handler: async (ctx) => {
      const failed: { plugin: string; message: string }[] = [];
      const ready = await probe.list(ctx, { onUnavailable: ({ plugin, message }) => failed.push({ plugin, message }) });
      return { ready: ready.map(({ id }) => id).sort(), failed };
    },
  });
`,
  `
  import { contract, type ActionSignal, type AuthContext } from "@tokamak/sdk";
  export const probe = contract<{
    id?: string;
    identify(): Promise<AuthContext>;
    hold(input: { path: string; signal: ActionSignal }): Promise<string>;
    badResult(): Promise<string>;
    echo(value: unknown): Promise<unknown>;
    deepResult(): Promise<unknown>;
    largeResult(): Promise<string>;
    thrown(): Promise<void>;
  }>("probe", { place: "local", dataMethods: true });
  export const ownProbe = contract<{ echo(value: unknown): Promise<unknown> }>("ownProbe", {
    place: "local", dataMethods: true,
  });
`,
);

function provider(id) {
  return `
    /// <reference types="node" />
    import { readFile, writeFile } from "node:fs/promises";
    import { local, provide, type ActionSignal } from "@tokamak/sdk";
    import { probe } from "plugin:${owner}/contracts";
    const identify = local({ handler: async (ctx) => ctx.auth });
    const hold = local({ handler: async (_ctx, { path, signal }: { path: string; signal: ActionSignal }) => {
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            void readFile(path + ".release").then(() => { clearInterval(timer); resolve(); }, () => {});
          }, 20);
          signal.addEventListener("abort", () => {
            clearInterval(timer);
            void writeFile(path + ".cancelled", "cancelled").then(() => resolve());
          }, { once: true });
          void writeFile(path + ".started", "started");
        });
        return "${id}";
    } });
    export default provide(probe, {
      id: "custom-alpha", identify, hold,
      badResult: async () => (() => {}) as unknown as string,
      echo: async (value) => value,
      deepResult: async () => Array.from({ length: 140 }).reduce((value) => [value], null as unknown),
      largeResult: async () => "🙂".repeat(300_000),
      thrown: async () => { throw new Error("original provider exception"); },
    });
  `;
}

await plugin(alpha, provider(alpha));
const distFor = (id) => join(plugins, id, "dist");
const cloneProvider = async (id) => {
  const dist = distFor(id);
  await cp(distFor(alpha), dist, { recursive: true });
  const path = join(dist, "manifest.json");
  const manifest = await Bun.file(path).json();
  manifest.plugin.id = id;
  await writeFile(path, JSON.stringify(manifest));
  const file = join(dist, "local.js");
  const code = (await readFile(file, "utf8"))
    .replaceAll(alpha, id)
    .replaceAll("custom-alpha", `custom-${id.slice("routed-".length)}`);
  manifest.hashes["local.js"] = createHash("sha256").update(code).digest("hex");
  await writeFile(file, code);
  await writeFile(path, JSON.stringify(manifest));
};
await cloneProvider(beta);
await cloneProvider(crash);
await editBundle(distFor(crash), 'throw new Error("startup fixture crash");');

// The Rust harness includes stderr on failure, alongside the Runner's stderr.
const onClosedFrame = (frame) => console.error("Runner local worker:", JSON.stringify(frame));
const runner = await startRunner({
  binary,
  plugins,
  directory,
  env: { TOKAMAK_PLUGIN_RUNTIME: "quickjs" },
  onClosedFrame,
});
const cleanup = [];

try {
  const { ws, token } = runner.endpoint;
  const connectWindow = () =>
    connect(ws, {
      token,
      launch: runner.launch,
      cleanup,
      onClose: ({ code, reason }) =>
        console.error("Runner workspace socket:", JSON.stringify({ code, reason })),
    });
  const hosts = await inspectHosts(runner);
  const pids = () =>
    Object.fromEntries(
      hosts()
        .filter(({ id }) => id !== crash)
        .map(({ id, pid }) => [id, pid]),
    );
  const alive = (pid) => {
    const state = Bun.spawnSync(["ps", "-ww", "-o", "stat=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    return state && !state.startsWith("Z");
  };
  const client = await connectWindow();
  const api = createApi(owner).probe;
  const auth = await client.query(authCaller, {});
  assert.deepEqual(await client.local(api.identify, { id: "custom-alpha" }), auth);
  assert.deepEqual(await client.local(api.identify, { id: "custom-beta" }), auth);
  const initial = pids();
  assert.deepEqual(Object.keys(initial).sort(), [alpha, beta, owner].sort());
  assert.equal(new Set(Object.values(initial)).size, 3);
  assert.deepEqual(await client.local(api.selfCall, { invalid: false }), { ok: true });
  await assert.rejects(
    client.local(api.selfCall, { invalid: true }),
    /routed-owner\/ownProbe\.echo arguments/,
  );
  assert.deepEqual(pids(), initial, "a self route reuses the original host");
  console.log("Three distinct local process PIDs; provider received the signed-in member and device");

  await assert.rejects(client.local(api.badArgs, {}), /routed-owner\/probe\.hold arguments/);
  await assert.rejects(client.local(api.badResult, {}), /routed-owner\/probe\.badResult result/);
  await assert.rejects(client.local(api.deepArgs, {}), /probe\.echo arguments.*nesting limit/);
  await assert.rejects(client.local(api.largeArgs, {}), /probe\.echo arguments.*size limit/);
  await assert.rejects(client.local(api.deepResult, {}), /probe\.deepResult result.*nesting limit/);
  await assert.rejects(client.local(api.largeResult, {}), /probe\.largeResult result.*size limit/);
  await assert.rejects(client.local(api.thrown, {}), /Plugin routed-alpha: original provider exception/);
  assert.deepEqual(pids(), initial, "data boundary failures must not kill any warmed host");

  const begin = async (id, name, signal, cancelCall = false) => {
    const path = join(scratch, name);
    const result = client.local(
      api.hold,
      { id: `custom-${id.slice("routed-".length)}`, path, cancelCall },
      { signal },
    );
    await Promise.race([
      until(name + " started", () => Bun.file(path + ".started").exists()),
      result.then(() => assert.fail(`${name} completed before the provider was ready`)),
    ]);
    return { path, result };
  };
  const cancel = new AbortController();
  const cancelled = await begin(alpha, "cancel", cancel.signal);
  cancel.abort();
  await assert.rejects(cancelled.result, /cancelled/);
  await until("provider observed cancellation", () => Bun.file(cancelled.path + ".cancelled").exists());
  const leaf = await begin(alpha, "cancel-routed-call", undefined, true);
  await writeFile(leaf.path + ".stop", "");
  assert.deepEqual(await leaf.result, auth, "the caller can still make another call");
  await until("the provider's reconstructed signal aborted", () =>
    Bun.file(leaf.path + ".cancelled").exists(),
  );
  assert.deepEqual(await client.local(api.cancelBurst, {}), auth);
  assert.deepEqual(pids(), initial, "consecutive bursts of cancels leave all hosts running");
  console.log(
    "Non-plain arguments and results named their method; cancelling the caller aborted the provider",
  );

  const first = await begin(alpha, "kill-alpha");
  const second = await begin(beta, "keep-beta");
  process.kill(initial[alpha], "SIGKILL");
  await assert.rejects(first.result, /Plugin routed-alpha process/);
  await writeFile(second.path + ".release", "");
  assert.equal(await second.result, beta);
  await until(
    "alpha recovers",
    async () =>
      await client.local(api.identify, { id: "custom-alpha" }).then(
        () => true,
        () => false,
      ),
  );
  const afterCrash = pids();
  assert.notEqual(afterCrash[alpha], initial[alpha]);
  assert.equal(afterCrash[beta], initial[beta]);
  assert.equal(afterCrash[owner], initial[owner]);
  console.log("SIGKILL failed only alpha's in-flight call; beta finished and the next look restarted alpha");

  // Disconnect one window and attach a new one without losing the idle processes.
  for (const close of cleanup.splice(0).reverse()) await close();
  const next = await connectWindow();
  assert.deepEqual(await next.local(api.identify, { id: "custom-alpha" }), auth);
  assert.deepEqual(pids(), afterCrash);

  await editBundle(distFor(alpha), "/* replacement local artifact */");
  await reload(runner, directory, alpha);
  await until("reloaded alpha stopped", () => !alive(afterCrash[alpha]));
  assert.deepEqual(await next.local(api.identify, { id: "custom-alpha" }), auth);
  const afterReload = pids();
  assert.notEqual(afterReload[alpha], afterCrash[alpha]);
  assert.equal(afterReload[beta], initial[beta]);
  assert.equal(afterReload[owner], initial[owner]);
  console.log("Closing the window kept all three PIDs; reloading alpha replaced only alpha");

  // The first lookup has no cached description for the crashing provider
  // whose implementation id differs from its plugin id.
  await Bun.sleep(260);
  await assert.rejects(next.local(api.checkBad, {}), /custom-crash.*Plugin routed-crash process/);
  for (const delay of [500, 1000, 2000]) {
    await Bun.sleep(delay + 25);
    await assert.rejects(next.local(api.checkBad, {}), /custom-crash.*Plugin routed-crash process/);
  }
  const start = performance.now();
  assert.deepEqual((await next.local(api.list, {})).sort(), ["custom-alpha", "custom-beta"]);
  await assert.rejects(next.local(api.checkBad, {}), /routed-crash process: restarting after a crash/);
  assert.ok(performance.now() - start < 1_500, "lookup waited for the 4 s provider back-off");
  console.log("Unavailable custom ID preserves the provider error; listings skip its back-off");

  const legacyProvider = "routed-legacy";
  await cloneProvider(legacyProvider);
  await editBundle(
    distFor(legacyProvider),
    `
const legacyRegistration = Object.keys(contractProviders)[0];
const legacyProvider = contractProviders[legacyRegistration];
contractProviders[legacyRegistration] = {
  ...legacyProvider,
  contract: { ...legacyProvider.contract, dataMethods: ["identify"] },
};
`,
  );
  const legacyManifest = join(distFor(legacyProvider), "manifest.json");
  const legacySpec = await Bun.file(legacyManifest).json();
  legacySpec.contractProviders[0].dataMethods = ["identify"];
  await writeFile(legacyManifest, JSON.stringify(legacySpec));
  await reload(runner, directory, legacyProvider);
  // The reload control reply and the window's catalog event travel on different sockets.
  const catalog = Promise.withResolvers();
  await until("window sees the reloaded legacy provider", async () => {
    const value = await next.local(api.unavailable, {});
    if (!value.failed.some(({ plugin }) => plugin === legacyProvider)) return false;
    catalog.resolve(value);
    return true;
  });
  const unavailable = await catalog.promise;
  assert.deepEqual(unavailable.ready, ["custom-alpha", "custom-beta"]);
  assert.match(
    unavailable.failed.find(({ plugin }) => plugin === legacyProvider)?.message ?? "",
    /routed-owner\/probe is not all plain data.*Rebuild or update this plugin/,
  );
  assert.ok(!hosts().some(({ id }) => id === legacyProvider));
  assert.deepEqual(await next.local(api.identify, { id: "custom-alpha" }), auth);
  console.log("Legacy mixed provider listed unavailable with a rebuild message without starting a host");

  await checkRoutesAndBuilds(runner, hosts);
  assert.equal(await within(runner.stop(), "Runner stop"), 0);
  await until("every host reaped", () => Object.values(afterReload).every((pid) => !alive(pid)));
  console.log("Graceful Runner stop reaped all three local hosts");
} finally {
  for (const close of cleanup.reverse()) await close();
  await runner.stop();
}

async function checkRoutesAndBuilds(runner, hosts) {
  const id = "two-builds";
  const code = (version) => `
    export const functions = {
      ping: { kind: "local", args: { kind: "any" }, invoke: () => ${version} },
      hold: { kind: "local", args: { kind: "any" }, invoke: (_, ctx) => ctx.op("test.hold", {}) },
      stuck: { kind: "local", args: { kind: "any" }, invoke: (_, ctx) => ctx.op("test.stuck", {}) },
    };
  `;
  const old = await installLocal(join(plugins, id), id, code(1));
  const replacement = await installLocal(join(plugins, id + "-alternate"), id, code(2));
  const holding = Promise.withResolvers();
  const release = Promise.withResolvers();
  const stuck = Promise.withResolvers();
  const handle = async (frame, _worker, respond) => {
    if (frame.name === "test.stuck") {
      stuck.resolve(); // The window never answers this operation.
      return;
    }
    holding.resolve();
    await release.promise;
    await respond("old build completed");
  };
  const [first, second, latest] = await Promise.all([
    rawWindow(runner, old, handle),
    rawWindow(runner, old, handle),
    rawWindow(runner, replacement, handle),
  ]);
  try {
    assert.deepEqual(await Promise.all([first.invoke("ping", null), second.invoke("ping", null)]), [1, 1]);
    const oldHosts = () => hosts().filter((host) => host.id === id);
    assert.equal(oldHosts().length, 1, "simultaneous startup of the same build must reuse a PID");
    const pid = oldHosts()[0].pid;
    const busy = second.invoke("hold", null);
    void busy.catch(() => {});
    await within(holding.promise, "old build hold");
    assert.equal(await latest.invoke("ping", null), 2);
    assert.equal(oldHosts().length, 2, "different local hashes must start a second build");
    await first.retire();
    await second.retire({ id }); // Malformed retirement must not close the busy window.
    release.resolve();
    assert.equal(await busy, "old build completed");
    assert.equal(await second.invoke("ping", null), 1);
    const stuckCall = assert.rejects(second.invoke("stuck", null), /closed|stopped/i);
    void stuckCall.catch(() => {});
    await within(stuck.promise, "stuck invocation admitted");
    await second.retire();
    await second.close();
    await stuckCall;
    await until("unused retired build stopped", () => !oldHosts().some((host) => host.pid === pid));
    assert.equal(await latest.invoke("ping", null), 2);
    console.log(
      "Two windows share one build, a different build coexists, and closing the last window cancels a stuck retired invocation",
    );
  } finally {
    await Promise.all([first.close(), second.close(), latest.close()]);
  }

  // Shared workspace catalogs are not observed by the Runner's own server.
  // A disconnected workspace supersedes its old idle build on the next acquire.
  const remote = "wss://test.invalid/shared";
  const remoteId = "shared-version";
  const v1 = await installLocal(join(plugins, remoteId), remoteId, code(1));
  const firstRemote = await rawWindow(runner, v1, handle, remote);
  let oldRemotePid;
  try {
    assert.equal(await firstRemote.invoke("ping", null), 1);
    oldRemotePid = hosts().find(({ id }) => id === remoteId).pid;
  } finally {
    await firstRemote.close();
  }
  // Historic use by a different workspace does not pin an unused process.
  const previousVisitor = await rawWindow(runner, v1, handle, "wss://other.test.invalid/ws");
  assert.equal(await previousVisitor.invoke("ping", null), 1);
  await previousVisitor.close();
  assert.ok(hosts().some(({ pid }) => pid === oldRemotePid));
  const v2 = await installLocal(join(plugins, remoteId), remoteId, code(2));
  const secondRemote = await rawWindow(runner, v2, handle, remote);
  try {
    assert.equal(await secondRemote.invoke("ping", null), 2);
    await until("disconnected shared workspace's old process stopped", () =>
      hosts().every(({ pid }) => pid !== oldRemotePid),
    );
    assert.equal(hosts().filter(({ id }) => id === remoteId).length, 1);
  } finally {
    await secondRemote.close();
  }

  const legacyId = "legacy-local";
  const legacyDir = join(plugins, legacyId);
  const legacy = await installLocal(legacyDir, legacyId, code(1));
  const manifestFile = join(legacyDir, "manifest.json");
  const manifest = await Bun.file(manifestFile).json();
  manifest.contracts = [{ name: "mixed", place: "local", dataMethods: ["read"] }];
  await writeFile(manifestFile, JSON.stringify(manifest));
  const legacyWindow = await rawWindow(runner, legacy, handle);
  try {
    await assert.rejects(legacyWindow.invoke("ping", null), /legacy-local\/mixed is not all plain data/);
    assert.ok(!hosts().some(({ id }) => id === legacyId));
  } finally {
    await legacyWindow.close();
  }

  const pair = await Promise.all(
    ["isolation-first", "isolation-second"].map((id, index) => {
      const marker = join(scratch, id + ".evaluated");
      const peer = index === 0 ? "isolation-second" : "isolation-first";
      return installLocal(
        join(plugins, id),
        id,
        `
      import { writeFile } from "node:fs/promises";
      await writeFile(${JSON.stringify(marker)}, process.pid + "\\n", { flag: "a" });
      export const functions = {
        askPeer: { kind: "local", args: { kind: "any" }, invoke: (_, ctx) =>
          ctx.op("local.contract.call", {
            plugin: "${peer}", owner: "${id}", name: "probe",
            registration: "provider", method: "pid", args: [],
          }) },
      };
      export const contractProviders = {
        provider: {
          contract: { owner: "${peer}", name: "probe", place: "local", dataMethods: true },
          implementation: { pid: () => process.pid },
        },
      };
    `,
      );
    }),
  );
  const windows = await Promise.all(
    pair.map((artifact, i) =>
      rawWindow(runner, artifact, (frame, worker) => worker.route(frame.id, pair[1 - i])),
    ),
  );
  try {
    const results = await Promise.all(windows.map((window) => window.invoke("askPeer", null)));
    for (const [index, artifact] of pair.entries()) {
      const own = hosts().filter(({ id }) => id === artifact.id);
      assert.equal(own.length, 1);
      const [{ pid }] = own;
      assert.equal(results[1 - index], pid, "the routed method ran in its provider's host");
      assert.equal(
        await readFile(join(scratch, artifact.id + ".evaluated"), "utf8"),
        pid + "\n",
        "the local bundle was evaluated exactly once, in its own host",
      );
    }
    console.log("Calls in both directions evaluated each bundle exactly once in its own process");
  } finally {
    await Promise.all(windows.map((window) => window.close()));
  }

  const chainCode = `
    const call = (plugins, op) => {
      const [plugin, ...rest] = plugins;
      return plugin ? op("local.contract.call", {
        plugin, owner: "chain", name: "probe", registration: "next", method: "next", args: [rest],
      }) : "end";
    };
    export const functions = {
      ping: { kind: "local", args: { kind: "any" }, invoke: () => "pong" },
      walk: { kind: "local", args: { kind: "any" }, invoke: (args, ctx) => call(args, ctx.op) },
    };
    export const contractProviders = {
      next: {
        contract: { name: "probe", owner: "chain", place: "local", dataMethods: true },
        implementation: { next: { kind: "local", invokeLocal: (args, bridge) => call(args, bridge.op) } },
      },
    };
  `;
  const chain = await Promise.all(
    Array.from({ length: 17 }, (_, index) => {
      const id = `chain-${index}`;
      return installLocal(join(plugins, id), id, chainCode);
    }),
  );
  let malformed = "missing";
  const missing = Promise.withResolvers();
  const driver = await rawWindow(runner, chain[0], (frame, worker) => {
    const target = chain.find(({ id }) => id === frame.payload.plugin);
    assert.ok(target);
    const kind = malformed;
    if (kind === "missing") {
      missing.resolve({ id: frame.id, worker, target });
      return worker.route(undefined, target);
    }
    if (kind === "string") return worker.route(String(frame.id), target);
    return worker.route(frame.id, kind === "artifact" ? { id: target.id } : target);
  });
  try {
    const pending = driver.invoke("walk", ["chain-1"]);
    const { id, target, worker } = await within(missing.promise, "route without an operation ID");
    assert.equal(await driver.invoke("ping", null), "pong");
    await worker.route(id, target);
    assert.equal(await pending, "end");
    malformed = "string";
    await assert.rejects(driver.invoke("walk", ["chain-1"]), /Invalid local contract route operation ID/);
    assert.equal(await driver.invoke("ping", null), "pong");
    malformed = "artifact";
    await assert.rejects(driver.invoke("walk", ["chain-1"]), /Invalid local contract route/);
    malformed = undefined;
    assert.equal(
      await driver.invoke(
        "walk",
        chain.slice(1, 16).map(({ id }) => id),
      ),
      "end",
    );
    await assert.rejects(
      driver.invoke("walk", ["chain-1", "chain-0"]),
      /cycle or depth limit at plugin chain-0/,
    );
    await assert.rejects(
      driver.invoke(
        "walk",
        chain.slice(1).map(({ id }) => id),
      ),
      /cycle or depth limit at plugin chain-16/,
    );
    assert.equal(
      hosts().some(({ id }) => id === "chain-16"),
      false,
    );
    console.log("Routed calls reject both cycles and a seventeenth host without launching it");
  } finally {
    await driver.close();
  }
}

const fakeHost = join(scratch, "fake-host");
await writeFile(
  fakeHost,
  `#!/bin/sh
[ "$1" = --local-plugin ] || exec "$(dirname "$0")/real-host" "$@"
case "$2" in
  diagnostic-provider)
    echo 'Discard this older diagnostic' >&2
    for n in 1 2 3 4 5 6 7; do echo "Retained stderr line $n" >&2; done
    echo 'Last provider startup diagnostic' >&2
    exit 1 ;;
  routed-alpha) ;;
  *) exec "$(dirname "$0")/real-host" "$@" ;;
esac
read -r invoke
printf '%s\\n' '{"type":"op","call":1,"id":1,"plugin":"routed-beta","name":"test.forged","payload":{}}'
read -r reply
case "$reply" in
  *"cannot claim plugin identity"*) error="forged identity refused" ;;
  *) error="forged identity forwarded" ;;
esac
printf '{"type":"result","id":1,"error":"%s"}\\n' "$error"
while read -r request; do :; done
`,
  { mode: 0o755 },
);
await symlink(
  process.env.TOKAMAK_PLUGIN_HOST ?? join(binary, "..", "tokamak-plugin-host"),
  join(scratch, "real-host"),
);
const simulatedPlugins = join(scratch, "simulated-plugins");
await mkdir(simulatedPlugins);
const simulated = await startRunner({
  binary,
  plugins: simulatedPlugins,
  directory: join(scratch, "impersonation"),
  env: { TOKAMAK_PLUGIN_RUNTIME: "quickjs", TOKAMAK_PLUGIN_HOST: fakeHost },
  onClosedFrame,
});
try {
  const artifact = await installLocal(join(simulatedPlugins, alpha), alpha, "export const functions = {};");
  const driver = await rawWindow(simulated, artifact, () =>
    assert.fail("Runner forwarded the forged operation to the window"),
  );
  try {
    await assert.rejects(driver.invoke("anything", null), /forged identity refused/);
    console.log("Runner refused an alpha host operation claiming beta's identity before forwarding it");
  } finally {
    await driver.close();
  }
  const provider = await installLocal(
    join(simulatedPlugins, "diagnostic-provider"),
    "diagnostic-provider",
    "export const functions = {};",
  );
  const caller = await installLocal(
    join(simulatedPlugins, "diagnostic-caller"),
    "diagnostic-caller",
    `export const functions = {call: { kind: "local", args: { kind: "any" }, invoke: (_, ctx) =>
      ctx.op("local.contract.call", {plugin: "diagnostic-provider", owner: "diagnostic-caller",
        name: "probe", registration: "provider", method: "info", args: []}) }};`,
  );
  const routed = await rawWindow(simulated, caller, (frame, worker) => worker.route(frame.id, provider));
  try {
    await assert.rejects(routed.invoke("call", null), (error) => {
      assert.match(error.message, /Plugin diagnostic-provider.*(?:closed|exited)/);
      assert.match(error.message, /Retained stderr line 1/);
      assert.match(error.message, /Last provider startup diagnostic/);
      assert.doesNotMatch(error.message, /Discard this older diagnostic/);
      return true;
    });
  } finally {
    await routed.close();
  }
} finally {
  assert.equal(await simulated.stop(), 0);
}
