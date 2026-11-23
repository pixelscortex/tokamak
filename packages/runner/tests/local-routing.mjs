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
  import { local, v } from "@tokamak/sdk";
  import { probe } from "../contracts";
  export const identify = local({
    args: { id: v.string() },
    handler: (ctx, { id }) => probe.get(id, ctx).identify(),
  });
  export const hold = local({
    args: { id: v.string(), path: v.string() },
    handler: (ctx, { id, path }) => probe.get(id, ctx).hold(path),
  });
  export const badArgs = local({
    handler: (ctx) => probe.get("custom-alpha", ctx).hold((() => {}) as unknown as string),
  });
  const nested = () => Array.from({ length: 140 }).reduce((value) => [value], null as unknown);
  export const badResult = local({ handler: (ctx) => probe.get("custom-alpha", ctx).badResult() });
  export const deepArgs = local({ handler: (ctx) => probe.get("custom-alpha", ctx).echo(nested()) });
  export const largeArgs = local({ handler: (ctx) => probe.get("custom-alpha", ctx).echo("🙂".repeat(300_000)) });
  export const deepResult = local({ handler: (ctx) => probe.get("custom-alpha", ctx).deepResult() });
  export const largeResult = local({ handler: (ctx) => probe.get("custom-alpha", ctx).largeResult() });
  export const thrown = local({ handler: (ctx) => probe.get("custom-alpha", ctx).thrown() });
  export const checkBad = local({ handler: (ctx) => probe.get("custom-crash", ctx).identify() });
  export const list = local({ handler: async (ctx) => (await probe.list(ctx)).map(({ id }) => id) });
`,
  `
  import { contract, type AuthContext } from "@tokamak/sdk";
  export const probe = contract<{
    id?: string;
    identify(): Promise<AuthContext>;
    hold(path: string): Promise<string>;
    badResult(): Promise<string>;
    echo(value: unknown): Promise<unknown>;
    deepResult(): Promise<unknown>;
    largeResult(): Promise<string>;
    thrown(): Promise<void>;
  }>("probe", { place: "local", dataMethods: true });
`,
);

function provider(id) {
  return `
    /// <reference types="node" />
    import { readFile, writeFile } from "node:fs/promises";
    import { local, provide } from "@tokamak/sdk";
    import { probe } from "plugin:${owner}/contracts";
    const identify = local({ handler: async (ctx) => ctx.auth });
    const hold = local({
      async handler(ctx, path: string) {
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            void readFile(path + ".release").then(() => { clearInterval(timer); resolve(); }, () => {});
          }, 20);
          ctx.signal.addEventListener("abort", () => {
            clearInterval(timer);
            void writeFile(path + ".cancelled", "cancelled").then(() => resolve());
          }, { once: true });
          void writeFile(path + ".started", "started");
        });
        return "${id}";
      },
    });
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

const runner = await startRunner({ binary, plugins, directory, env: { TOKAMAK_PLUGIN_RUNTIME: "quickjs" } });
const cleanup = [];

try {
  const { ws, token } = runner.endpoint;
  const hosts = await inspectHosts(runner);
  const pids = () =>
    Object.fromEntries(
      hosts()
        .filter(({ id }) => id !== crash)
        .map(({ id, pid }) => [id, pid]),
    );
  const alive = (pid) => {
    const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    return state && !state.startsWith("Z");
  };
  const client = await connect(ws, { token, launch: runner.launch, cleanup });
  const api = createApi(owner).probe;
  const auth = await client.query(authCaller, {});
  assert.deepEqual(await client.local(api.identify, { id: "custom-alpha" }), auth);
  assert.deepEqual(await client.local(api.identify, { id: "custom-beta" }), auth);
  const initial = pids();
  assert.deepEqual(Object.keys(initial).sort(), [alpha, beta, owner].sort());
  assert.equal(new Set(Object.values(initial)).size, 3);
  console.log("Three distinct local process PIDs; provider received the signed-in member and device");

  await assert.rejects(client.local(api.badArgs, {}), /routed-owner\/probe\.hold arguments/);
  await assert.rejects(client.local(api.badResult, {}), /routed-owner\/probe\.badResult result/);
  await assert.rejects(client.local(api.deepArgs, {}), /probe\.echo arguments.*nesting limit/);
  await assert.rejects(client.local(api.largeArgs, {}), /probe\.echo arguments.*size limit/);
  await assert.rejects(client.local(api.deepResult, {}), /probe\.deepResult result.*nesting limit/);
  await assert.rejects(client.local(api.largeResult, {}), /probe\.largeResult result.*size limit/);
  await assert.rejects(client.local(api.thrown, {}), /Plugin routed-alpha: original provider exception/);
  assert.deepEqual(pids(), initial, "data boundary failures must not kill any warmed host");

  const begin = async (id, name, signal) => {
    const path = join(scratch, name);
    const result = client.local(api.hold, { id: `custom-${id.slice("routed-".length)}`, path }, { signal });
    void result.catch(() => {});
    await until(name + " started", () => Bun.file(path + ".started").exists());
    return { path, result };
  };
  const cancel = new AbortController();
  const cancelled = await begin(alpha, "cancel", cancel.signal);
  cancel.abort();
  await assert.rejects(cancelled.result, /cancelled/);
  await until("provider observed cancellation", () => Bun.file(cancelled.path + ".cancelled").exists());
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
  const next = await connect(ws, { token, launch: runner.launch, cleanup });
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
    };
  `;
  const old = await installLocal(join(plugins, id), id, code(1));
  const replacement = await installLocal(join(plugins, id + "-alternate"), id, code(2));
  const holding = Promise.withResolvers();
  const release = Promise.withResolvers();
  const handle = async (_frame, _worker, respond) => {
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
    await first.retire(id);
    release.resolve();
    assert.equal(await busy, "old build completed");
    assert.equal(await second.invoke("ping", null), 1);
    await second.close();
    await until("unused retired build stopped", () => !oldHosts().some((host) => host.pid === pid));
    assert.equal(await latest.invoke("ping", null), 2);
    console.log(
      "Two windows share one build, a different build coexists, and retirement waits for the last window",
    );
  } finally {
    await Promise.all([first.close(), second.close(), latest.close()]);
  }

  // Shared workspace catalogs are not observed by the Runner's own server.
  // A disconnected workspace supersedes its old idle build on the next acquire.
  const remote = "wss://test.invalid/shared";
  const remoteId = "shared-version";
  const v1 = await installLocal(join(plugins, remoteId), remoteId, code(1));
  const firstRemote = await rawWindow(runner, v1, handle, [], remote);
  let oldRemotePid;
  try {
    assert.equal(await firstRemote.invoke("ping", null), 1);
    oldRemotePid = hosts().find(({ id }) => id === remoteId).pid;
  } finally {
    await firstRemote.close();
  }
  // Historic use by a different workspace does not pin an unused process.
  const previousVisitor = await rawWindow(runner, v1, handle, [], "wss://other.test.invalid/ws");
  assert.equal(await previousVisitor.invoke("ping", null), 1);
  await previousVisitor.close();
  assert.ok(hosts().some(({ pid }) => pid === oldRemotePid));
  const v2 = await installLocal(join(plugins, remoteId), remoteId, code(2));
  const secondRemote = await rawWindow(runner, v2, handle, [], remote);
  try {
    assert.equal(await secondRemote.invoke("ping", null), 2);
    await until("disconnected shared workspace's old process stopped", () =>
      hosts().every(({ pid }) => pid !== oldRemotePid),
    );
    assert.equal(hosts().filter(({ id }) => id === remoteId).length, 1);
  } finally {
    await secondRemote.close();
  }

  const chainCode = `
    const call = (plugins, op) => {
      const [plugin, ...rest] = plugins;
      return plugin ? op("local.contract.call", {
        plugin, owner: "chain", name: "probe", registration: "next", method: "next", args: [rest],
      }) : "end";
    };
    export const functions = {
      walk: { kind: "local", args: { kind: "any" }, invoke: (args, ctx) => call(args, ctx.op) },
    };
    export const contractProviders = {
      next: {
        contract: { name: "probe", owner: "chain", place: "local", dataMethods: ["next"] },
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
  let invalid = true;
  const driver = await rawWindow(runner, chain[0], (frame, worker) => {
    const target = chain.find(({ id }) => id === frame.payload.plugin);
    assert.ok(target);
    const profile = invalid ? [target] : [];
    invalid = false;
    return worker.route(frame.id, target, profile);
  });
  try {
    await assert.rejects(driver.invoke("walk", ["chain-1"]), /Invalid local plugin live profile/);
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
} finally {
  assert.equal(await simulated.stop(), 0);
}
