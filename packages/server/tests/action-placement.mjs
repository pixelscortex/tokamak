import assert from "node:assert/strict";
import { cp, readFile, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build, connect, startServer, within, workspace } from "../../../e2e/fake-agent/harness.mjs";
import { startRunner } from "../../../e2e/fake-agent/local.mjs";
import { authCaller, isLocalReloadTimeout } from "../../sdk/src/index.ts";
import { LOCAL_RELOAD_GRACE_MS } from "../../sdk/src/protocol.ts";
import { stageServerPlugin } from "../../build/src/stage-server-plugin.ts";

const [server, runner, mode] = process.argv.slice(2);
const cleanup = [];
const scratch = await mkdtemp(join(tmpdir(), "tokamak-action-placement-"));
const source = join(scratch, "ai");
const plugins = join(scratch, "plugins");
await cp(join(import.meta.dir, "fixtures/action-placement"), source, { recursive: true });
await symlink(join(workspace, "app/node_modules"), join(source, "node_modules"), "dir");
await writeFile(
  join(source, "tsconfig.json"),
  JSON.stringify({
    extends: join(workspace, "tsconfig.json"),
    compilerOptions: { lib: ["ES2022", "DOM"], types: ["node"] },
  }),
);
build(source);
await mkdir(plugins);
await cp(join(source, "dist"), join(plugins, "ai"), { recursive: true });
const hook = join(scratch, "fixture-hooks");
await mkdir(join(hook, "src"), { recursive: true });
await symlink(join(workspace, "app/node_modules"), join(hook, "node_modules"), "dir");
await writeFile(join(hook, "package.json"), JSON.stringify({ name: "fixture-hooks", version: "1.0.0" }));
await writeFile(
  join(hook, "tsconfig.json"),
  JSON.stringify({
    extends: join(workspace, "tsconfig.json"),
    compilerOptions: { lib: ["ES2022", "DOM"], types: ["node"] },
  }),
);
await writeFile(
  join(hook, "plugin.ts"),
  `
  import { definePlugin } from "@tokamak/sdk";
  export default definePlugin({ id: "fixture-hooks", version: "1.0.0", depends: ["ai"], permissions: ["net:127.0.0.1"] });
`,
);
await writeFile(
  join(hook, "src/policy.ts"),
  `
  import { action, hook, provide } from "@tokamak/sdk";
  import { localPlace } from "plugin:ai/contracts";
  import { audited, callerPoint, marker, pointLoop, rows, store, waitHook } from "plugin:ai/server";
  export const policy = hook(marker, { after: () => "hooked" });
  export const verifyStore = hook(store, {
    before: (_ctx, { text }) => ({ text: text.startsWith("pipeline:") ? text + ":mutation-hook" : text }),
  });
  export const verifyAction = hook(callerPoint, {
    after: (_ctx, result, args) =>
      args.verifyPipeline && typeof result === "string" ? result + ":action-hook" : result,
  });
  export const load = hook(callerPoint.points.load, {
    before: (ctx, { search }) => ({ search: search + ":" + ctx.call.depth }),
    after: (_ctx, result) => result.toUpperCase(),
  });
  export const loop = hook(pointLoop.points.loop, { before: (_ctx, value) => value + 1 });
  export const audit = hook(audited, {
    async before(ctx, args) {
      let denied = false;
      try {
        await ctx.env("FIXTURE_ACTION_PLACEMENT");
      } catch (error) {
        denied = String(error).includes("permission denied");
      }
      if (!denied) throw new Error("Hook could read the owner's environment");
      const response = await fetch(args.url);
      const marker = await response.text();
      await ctx.runQuery(rows, {});
      await ctx.runMutation(store, { text: marker + ":" + args.text });
      return { ...args, text: marker + ":" + ctx.call.depth + ":" + args.text };
    },
    after(_ctx, result) {
      return typeof result === "string" ? result.toUpperCase() : result;
    },
  });
  export const waitPolicy = hook(waitHook, {
    async before(ctx, args) {
      const process = ctx.proc(["/bin/sh", "-c", "echo $$; while /bin/sleep 1; do echo tick; done"]);
      for await (const pid of process.stdout) await ctx.runMutation(store, { text: pid });
      await process.exited;
      return args;
    },
  });
  export const provider = provide(localPlace, {
    id: "external",
    location: action({ on: "caller", handler: () => 1 }),
  });
`,
);
build(hook);
await cp(join(hook, "dist"), join(plugins, "fixture-hooks"), { recursive: true });
const oldProvider = join(scratch, "old-provider");
await cp(join(hook, "dist"), oldProvider, { recursive: true });
const policy = join(hook, "src/policy.ts");
await writeFile(policy, (await readFile(policy, "utf8")).replace("handler: () => 1", "handler: () => 2"));
build(hook);
const newProvider = join(hook, "dist");

const { api } = await import(join(source, "src/_generated/api.ts"));
const file = join(scratch, "input");
await writeFile(file, "text on the caller");
const args = { file, thread: "chat/threads:placement" };
const noMachine = { failed: true, kind: "noMachine", data: null };
const unavailable = (data) => ({ failed: true, kind: "runnerCapabilityUnavailable", data });

async function assertProgram(client, reference, depth) {
  const identity = await client.query(authCaller, {});
  assert.deepEqual(await client.action(reference, args), {
    verified: true,
    environment: "on this machine",
    auth: identity,
    call: { ...identity, threadId: args.thread, depth },
    queryCall: { ...identity, threadId: args.thread, depth: depth + 1 },
    output: ["started"],
    saved: true,
    status: 0,
  });
}

async function assertChannel(client) {
  const result = await within(
    client.action(api.channel.stream, {}),
    "stream, steer, and stop a channel",
    5000,
  );
  assert.deepEqual(result, {
    result: { sessionId: "fixture", stopped: true },
    received: ["started", "steered"],
  });
}

async function assertCancellation(client, actionRef = api.work.wait) {
  const previous = (await client.query(api.work.rows, {})).rows.length;
  const cancel = new AbortController();
  const action = client.action(actionRef, {}, { signal: cancel.signal });
  void action.catch(() => {});
  // Registration is synchronous; wait until the handler reached the workspace.
  try {
    await within(
      (async () => {
        while (!cancel.signal.aborted) {
          if ((await client.query(api.work.rows, {})).rows.length > previous) return;
          await Bun.sleep(20);
        }
      })(),
      "start cancellable action",
      5000,
    );
  } finally {
    cancel.abort();
  }
  await assert.rejects(within(action, "cancel running action", 5000), /cancelled/i);
}

async function assertLiveSignal(client) {
  const before = await client.action(api.channel.signalCount, {});
  await assertCancellation(client, api.channel.liveSignal);
  await within(
    (async () => {
      while ((await client.action(api.channel.signalCount, {})) === before) await Bun.sleep(20);
    })(),
    "provider observed live AbortSignal",
    5000,
  );
}

async function assertDisconnectAndCapacity(address, token, observer, count = 40) {
  const closing = [];
  const client = await connect(address, { token, cleanup: closing });
  const previous = (await observer.query(api.work.rows, {})).rows.length;
  const calls = Array.from({ length: count }, () => client.action(api.work.wait, {}));
  const results = Promise.allSettled(calls);
  try {
    const pids = await within(
      (async () => {
        for (;;) {
          const { rows } = await observer.query(api.work.rows, {});
          if (rows.length >= previous + count) return rows.slice(previous).map((row) => Number(row.text));
          await Bun.sleep(20);
        }
      })(),
      `admit ${count} caller actions`,
      10000,
    );
    assert.deepEqual(await observer.action(api.work.serverDefault, {}), { runner: false, depth: 0 });
    await closing.pop()();
    await within(results, "close action session", 5000);
    await assertProgramsReaped(pids, "reap programs after caller disconnect");
  } finally {
    for (const close of closing) await close();
  }
}

async function assertProgramsReaped(pids, label) {
  await within(
    (async () => {
      let running = pids;
      while (running.length) {
        running = running.filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
            return false;
          }
        });
        if (running.length) await Bun.sleep(20);
      }
    })(),
    label,
    5000,
  );
}

async function waitForProgram(client, previous, action) {
  const entered = (async () => {
    for (;;) {
      const { rows } = await client.query(api.work.rows, {});
      if (rows.length > previous) return Number(rows[previous].text);
      await Bun.sleep(20);
    }
  })();
  const pid = await within(
    action
      ? Promise.race([
          entered,
          action.then(() => {
            throw new Error("Retiring action finished before its process started");
          }),
        ])
      : entered,
    "start action on retiring build",
    5000,
  );
  assert.ok(Number.isInteger(pid) && pid > 0);
  return pid;
}

async function assertReloadTimeout(client, reference, args, reload) {
  const previous = (await client.query(api.work.rows, {})).rows.length;
  const action = client.action(reference, args);
  void action.catch(() => {});
  const pid = await waitForProgram(client, previous, action);
  await reload();
  const ticks = async () =>
    (await client.query(api.work.rows, {})).rows.filter((row) => row.text === "tick").length;
  const atReload = await ticks();
  await assert.rejects(
    within(action, "retired action times out", LOCAL_RELOAD_GRACE_MS + 3000),
    isLocalReloadTimeout,
  );
  await assertProgramsReaped([pid], "reap program from retired action");
  const after = await ticks();
  assert.ok(after > atReload, "the retiring action could still make nested calls");
  await Bun.sleep(1100);
  assert.equal(await ticks(), after, "no further nested calls after the grace period");
}

async function assertRetirementCleanup(client, marker, reload) {
  const action = client.action(api.channel.stream, { retire: marker });
  void action.catch(() => {});
  await within(
    (async () => {
      while (!(await client.query(api.work.rows, {})).rows.some((row) => row.text === marker)) {
        await Bun.sleep(20);
      }
    })(),
    "open channel on retiring build",
    5000,
  );
  await reload();
  assert.deepEqual(await within(action, `settle retired action (${marker})`, LOCAL_RELOAD_GRACE_MS + 3000), {
    result: { sessionId: "fixture", stopped: true },
    received: ["started", "steered"],
    settled: {
      mutation: "after reload",
      contract: 2,
      query: "hooked",
      action: { runner: true, depth: 1 },
    },
  });
}

async function reloadProvider(address, token, plugin = "fixture-hooks") {
  const route = new URL(`/plugins/${plugin}/reload`, address.replace(/^ws:/, "http:"));
  const response = await fetch(route, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200, await response.text());
}

async function assertProviderRefresh(client, gate, install) {
  const result = client.action(api.provider.refreshedProvider, { gate });
  void result.catch(() => {});
  const entered = (async () => {
    for (;;) {
      const { rows } = await client.query(api.work.rows, {});
      if (rows.some((row) => row.text === gate + ":ready")) return;
      await Bun.sleep(20);
    }
  })();
  await within(
    Promise.race([
      entered,
      result.then(() => {
        throw new Error(`${gate} completed before the reload`);
      }),
    ]),
    `enter action before ${gate}`,
    5000,
  );
  await install();
  await client.mutation(api.work.store, { text: gate });
  assert.deepEqual(await within(result, "call rebuilt provider", 5000), [1, 2]);
}

const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("network") });
cleanup.push(() => http.stop(true));
const auditArgs = { url: http.url.href, text: "audit" };

async function rejects_older_window_without_hook_plan_support(address, token, points = false) {
  const socket = new WebSocket(address, ["tokamak", `tokamak.bearer.${token}`]);
  try {
    const reply = await within(
      new Promise((resolve, reject) => {
        socket.addEventListener("error", reject, { once: true });
        socket.addEventListener(
          "open",
          () =>
            socket.send(
              JSON.stringify({
                type: "action",
                id: 1,
                name: points ? "ai/work:callerPoint" : "ai/work:audited",
                window: true,
                ...(points && { hookPlans: true }),
                args: points ? {} : auditArgs,
              }),
            ),
          { once: true },
        );
        socket.addEventListener("message", ({ data }) => {
          const event = JSON.parse(data);
          if (event.id === 1) resolve(event);
        });
      }),
      "old window hook capability",
    );
    assert.equal(reply.error?.kind, "hookRunnerUnavailable");
    assert.equal(reply.error?.plugin, "fixture-hooks");
    if (points) assert.equal(reply.error?.point, "load");
  } finally {
    socket.close();
  }
}

async function rejects_runner_without_point_plan_support(address, token, launch) {
  const client = await connect(address, {
    token,
    cleanup,
    launch: async (...args) => {
      const worker = await launch(...args);
      return {
        send: worker.send.bind(worker),
        close: worker.close.bind(worker),
        route: worker.route.bind(worker),
        retire: worker.retire.bind(worker),
      };
    },
  });
  await assert.rejects(client.action(api.work.callerPoint, {}), {
    plugin: "fixture-hooks",
    point: "load",
    stage: "pointBefore",
    kind: "hookRunnerUnavailable",
  });
}

async function action_hooks_run_with_network_and_database(client, reference, expectedDepth, options) {
  const before = (await client.query(api.work.rows, {})).rows.length;
  assert.equal(await client.action(reference, auditArgs, options), `NETWORK:${expectedDepth}:AUDIT`);
  const after = (await client.query(api.work.rows, {})).rows;
  assert.equal(after.length, before + 1);
  assert.deepEqual(
    after.slice(before).map(({ text }) => text),
    ["network:audit"],
  );
}

async function caller_point_runs_with_local_stages(client) {
  const before = (await client.query(api.work.rows, {})).rows.length;
  assert.equal(
    await client.action(api.work.callerPoint, { verifyPipeline: true }),
    "LOADED:OWNER:1:action-hook",
  );
  assert.deepEqual(
    (await client.query(api.work.rows, {})).rows.slice(before).map(({ text }) => text),
    ["pipeline:hooked:mutation-hook"],
  );
}

async function point_stages_share_the_window_budget(client) {
  assert.equal(await client.action(api.work.pointLoop, { count: 256 }), 256);
  await assert.rejects(client.action(api.work.pointLoop, { count: 257 }), {
    plugin: "fixture-hooks",
    stage: "pointBefore",
    point: "loop",
    kind: "hookDepthLimit",
  });
}

try {
  const local = await startRunner({
    binary: runner,
    plugins,
    directory: join(scratch, "runner"),
    env: {
      FIXTURE_ACTION_PLACEMENT: "on this machine",
      ...(process.env.TOKAMAK_TEST_RUNNER_HOST && {
        TOKAMAK_PLUGIN_HOST: process.env.TOKAMAK_TEST_RUNNER_HOST,
      }),
    },
  });
  cleanup.push(local.stop);
  const embedded = await connect(local.endpoint.ws, { token: local.endpoint.token, cleanup });
  await assertProgram(embedded, api.delegate.program, 1);
  await action_hooks_run_with_network_and_database(embedded, api.delegate.audit, 2);
  assert.deepEqual(await embedded.action(api.provider.contractCall, {}), { runner: true, depth: 1 });
  assert.deepEqual(await embedded.action(api.delegate.choose, { on: "caller" }), { runner: true, depth: 1 });
  assert.deepEqual(await embedded.action(api.delegate.choose, { on: "server" }), { runner: false, depth: 1 });
  await assertProgram(embedded, api.work.run, 0);
  await caller_point_runs_with_local_stages(embedded);
  assert.equal(await embedded.action(api.provider.callLocalContract, {}), 1);
  assert.deepEqual(await embedded.action(api.provider.callServerContract, {}), { runner: true, depth: 1 });
  assert.equal(await embedded.action(api.work.callPrivate, {}), 1);
  await assertCancellation(embedded);
  await assertChannel(embedded);
  await assertLiveSignal(embedded);
  assert.equal(await embedded.action(api.work.hookedQuery, {}), "hooked");
  assert.equal(await embedded.action(api.work.useFailureValue, {}), true);

  const serverPlugins = mode === "--cloud" ? join(scratch, "cloud") : plugins;
  if (mode === "--cloud") {
    await stageServerPlugin(join(source, "dist"), join(serverPlugins, "ai"));
    await stageServerPlugin(oldProvider, join(serverPlugins, "fixture-hooks"));
  }
  const privateDir = join(scratch, "shared");
  const sharedToken = "ab".repeat(32);
  await mkdir(privateDir);
  await writeFile(join(privateDir, "server.token"), sharedToken, { mode: 0o600 });
  const shared = Bun.spawn(
    [
      server,
      "--plugins",
      serverPlugins,
      "--data",
      join(scratch, "db"),
      "--listen",
      "127.0.0.1:0",
      "--local-dir",
      privateDir,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  cleanup.push(async () => {
    shared.kill();
    await shared.exited;
  });
  const reader = shared.stdout.getReader();
  let announcement = "";
  try {
    while (!announcement.includes("\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "Server exited before listening");
      announcement += new TextDecoder().decode(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const address = announcement.match(/ws:\/\/[^\s]+/)?.[0];
  assert.ok(address, announcement);
  const window = await connect(address, { launch: local.launch, token: sharedToken, cleanup });
  const browser = await connect(address, { token: sharedToken, cleanup });

  await assertProgram(window, api.work.run, 0);
  assert.deepEqual(await window.action(api.delegate.caller, {}), { runner: true, depth: 1 });
  assert.deepEqual(await window.action(api.delegate.caller, { override: true }), { runner: true, depth: 1 });
  assert.equal(await window.action(api.work.read, { file }), "text on the caller");
  assert.deepEqual(await window.action(api.work.read, { file }, { on: "server" }), noMachine);
  assert.equal((await browser.query(api.work.rows, {})).rows.length, 1);
  await rejects_older_window_without_hook_plan_support(address, sharedToken);
  await rejects_older_window_without_hook_plan_support(address, sharedToken, true);
  await rejects_runner_without_point_plan_support(address, sharedToken, local.launch);
  await caller_point_runs_with_local_stages(window);
  await point_stages_share_the_window_budget(window);
  await action_hooks_run_with_network_and_database(window, api.work.audited, 1);
  await action_hooks_run_with_network_and_database(browser, api.work.audited, 1, { on: "server" });
  assert.deepEqual(await window.action(api.work.serverDefault, {}), { runner: false, depth: 0 });
  assert.deepEqual(await window.action(api.work.serverDefault, {}, { on: "caller" }), {
    runner: true,
    depth: 0,
  });
  assert.deepEqual(await window.action(api.work.callerDefault, {}, { on: "server" }), {
    runner: false,
    depth: 0,
  });
  assert.deepEqual(await browser.action(api.delegate.choose, { on: "server" }), { runner: false, depth: 1 });
  assert.deepEqual(await browser.action(api.delegate.choose, { on: "caller" }), noMachine);
  assert.deepEqual(await browser.action(api.work.run, args), noMachine);
  assert.equal(await window.action(api.provider.callLocalContract, {}), 1);
  assert.deepEqual(await window.action(api.provider.callServerContract, {}), unavailable("serverContracts"));
  assert.deepEqual(await window.action(api.work.callPrivate, {}), unavailable("privateFunctions"));
  await assertCancellation(window);
  await assertChannel(window);
  await assertLiveSignal(window);
  assert.equal(await window.action(api.work.hookedQuery, {}), "hooked");
  assert.equal(await window.action(api.work.useFailureValue, {}), true);
  assert.deepEqual(
    await within(browser.action(api.work.run, args, { on: "server" }), "server program request", 5000),
    noMachine,
  );
  await assertProviderRefresh(embedded, "embedded-refresh", async () => {
    await cp(newProvider, join(plugins, "fixture-hooks"), { recursive: true });
    await reloadProvider(local.endpoint.http, local.endpoint.token);
  });
  await cp(oldProvider, join(plugins, "fixture-hooks"), { recursive: true });
  await reloadProvider(local.endpoint.http, local.endpoint.token);
  if (mode === "--cloud") {
    const staged = join(scratch, "unavailable-hook");
    await stageServerPlugin(newProvider, staged);
    await cp(staged, join(serverPlugins, "fixture-hooks"), { recursive: true });
    await reloadProvider(address, sharedToken);
    await assert.rejects(window.action(api.work.audited, auditArgs), {
      plugin: "fixture-hooks",
      stage: "before",
      kind: "hookRunnerUnavailable",
    });
    await assert.rejects(window.action(api.work.callerPoint, {}), {
      plugin: "fixture-hooks",
      stage: "pointBefore",
      point: "load",
      kind: "hookRunnerUnavailable",
    });
    await cp(oldProvider, join(serverPlugins, "fixture-hooks"), { recursive: true });
    await reloadProvider(address, sharedToken);
  }
  await assertProviderRefresh(window, "window-refresh", async () => {
    await cp(newProvider, join(plugins, "fixture-hooks"), { recursive: true });
    if (mode === "--cloud") {
      const staged = join(scratch, "new-provider-cloud");
      await stageServerPlugin(newProvider, staged);
      await cp(staged, join(serverPlugins, "fixture-hooks"), { recursive: true });
    }
    await reloadProvider(address, sharedToken);
  });
  await reloadProvider(local.endpoint.http, local.endpoint.token);
  await assertDisconnectAndCapacity(local.endpoint.ws, local.endpoint.token, embedded);
  const oldAction = join(scratch, "old-action");
  await cp(join(source, "dist"), oldAction, { recursive: true });
  const actionSource = join(source, "src/work.ts");
  await writeFile(
    actionSource,
    (await readFile(actionSource, "utf8"))
      .replace("before reload", "after reload")
      .replace("exec /bin/sleep 30", "exec /bin/sleep 31"),
  );
  build(source);
  const newAction = join(source, "dist");

  const reloadEmbedded = async (artifact) => {
    await cp(artifact, join(plugins, "ai"), { recursive: true });
    await reloadProvider(local.endpoint.http, local.endpoint.token, "ai");
  };
  const reloadWindow = async (artifact) => {
    await cp(artifact, join(plugins, "ai"), { recursive: true });
    if (mode === "--cloud") {
      const staged = join(await mkdtemp(join(scratch, "action-cloud-")), "ai");
      await stageServerPlugin(artifact, staged);
      await cp(staged, join(serverPlugins, "ai"), { recursive: true });
    }
    await reloadProvider(address, sharedToken, "ai");
  };
  await assertRetirementCleanup(embedded, "embedded-retiring", () => reloadEmbedded(newAction));
  await reloadEmbedded(oldAction);
  await assertReloadTimeout(embedded, api.work.wait, { repeat: true }, () => reloadEmbedded(newAction));
  await reloadEmbedded(oldAction);
  await assertReloadTimeout(embedded, api.work.waitHook, {}, () => reloadEmbedded(newAction));
  await reloadEmbedded(oldAction);

  await assertRetirementCleanup(window, "window-retiring", () => reloadWindow(newAction));
  await reloadWindow(oldAction);
  await assertReloadTimeout(window, api.work.wait, { repeat: true }, () => reloadWindow(newAction));
  await reloadWindow(oldAction);
  await assertReloadTimeout(window, api.work.waitHook, {}, () => reloadWindow(newAction));
  async function installConnectedProvider(artifact) {
    await cp(artifact, join(plugins, "fixture-hooks"), { recursive: true });
    if (mode === "--cloud") {
      const staged = join(await mkdtemp(join(scratch, "connected-provider-cloud-")), "fixture-hooks");
      await stageServerPlugin(artifact, staged);
      await cp(staged, join(serverPlugins, "fixture-hooks"), { recursive: true });
    }
  }
  await installConnectedProvider(oldProvider);
  const servers = [];
  const connectedAddress = await startServer({
    binary: server,
    dir: join(scratch, "connected-server"),
    pluginsDir: serverPlugins,
    shared: true,
    ownerToken: sharedToken,
    servers,
    cleanup,
    started: (child) =>
      cleanup.push(async () => {
        child.kill();
        await child.exited;
      }),
  });
  const connectedOrigin = connectedAddress.replace(/^ws:/, "http:").replace(/\/ws$/, "");
  const issued = await fetch(new URL("/auth/owner", connectedOrigin), {
    method: "POST",
    headers: { Authorization: `Bearer ${sharedToken}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceName: "Connected retirement Runner" }),
  });
  assert.equal(issued.status, 200);
  const { key } = await issued.json();
  const keyFile = join(scratch, "connected.key");
  await writeFile(keyFile, key, { mode: 0o600 });
  const connectedRunner = Bun.spawn(
    [
      runner,
      "--server",
      connectedOrigin,
      "--key-file",
      keyFile,
      "--plugins",
      plugins,
      "--data",
      join(scratch, "connected-data"),
    ],
    {
      env: {
        ...process.env,
        FIXTURE_ACTION_PLACEMENT: "on this machine",
        ...(process.env.TOKAMAK_TEST_RUNNER_HOST && {
          TOKAMAK_PLUGIN_HOST: process.env.TOKAMAK_TEST_RUNNER_HOST,
        }),
      },
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  cleanup.push(async () => {
    connectedRunner.kill();
    await connectedRunner.exited;
  });
  const connected = await connect(connectedAddress, { token: key, cleanup });
  await within(
    (async () => {
      while ((await connected.action(api.work.callerDefault, {})).kind === "noMachine") {
        await Bun.sleep(20);
      }
    })(),
    "connect the retirement Runner",
    5000,
  );

  await assertProviderRefresh(connected, "connected-refresh", async () => {
    await installConnectedProvider(newProvider);
    await reloadProvider(connectedAddress, sharedToken);
  });

  const reloadConnected = async (artifact) => {
    await cp(artifact, join(plugins, "ai"), { recursive: true });
    if (mode === "--cloud") {
      const staged = join(await mkdtemp(join(scratch, "connected-action-cloud-")), "ai");
      await stageServerPlugin(artifact, staged);
      await cp(staged, join(serverPlugins, "ai"), { recursive: true });
    }
    await reloadProvider(connectedAddress, sharedToken, "ai");
  };
  await assertRetirementCleanup(connected, "connected-retiring", () => reloadConnected(newAction));
  await reloadConnected(oldAction);
  await assertReloadTimeout(connected, api.work.wait, { repeat: true }, () => reloadConnected(newAction));
  await assertDisconnectAndCapacity(connectedAddress, key, connected, 1);
  await assertLiveSignal(connected);

  const beforeShutdown = (await connected.query(api.work.rows, {})).rows.length;
  const interrupted = connected.action(api.work.wait, {});
  void interrupted.catch(() => {});
  const runningPid = await waitForProgram(connected, beforeShutdown);
  connectedRunner.kill("SIGTERM");
  assert.deepEqual(await within(interrupted, "stop connected Runner action", 5000), {
    failed: true,
    kind: "machineLost",
    data: null,
  });
  assert.equal(await within(connectedRunner.exited, "stop connected Runner", 5000), 0);
  await assertProgramsReaped([runningPid], "reap a program after connected Runner shutdown");
  console.log("Reload regression passed on the embedded, window-routed, and connected Runners.");

  await local.stop();
  const offlineWindow = await connect(address, { launch: local.launch, token: sharedToken, cleanup });
  assert.deepEqual(
    await within(offlineWindow.action(api.work.run, args), "Runner unavailable", 5000),
    noMachine,
  );
} finally {
  for (const stop of cleanup.reverse()) await stop();
}
