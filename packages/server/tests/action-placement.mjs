import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build, connect, within, workspace } from "../../../e2e/fake-agent/harness.mjs";
import { startRunner } from "../../../e2e/fake-agent/local.mjs";
import { authCaller } from "../../sdk/src/index.ts";
import { stageServerPlugin } from "../../build/src/stage-server-plugin.ts";

const [server, runner, mode] = process.argv.slice(2);
const cleanup = [];
const scratch = await mkdtemp(join(tmpdir(), "tokamak-action-placement-"));
const source = join(scratch, "source");
const plugins = join(scratch, "plugins");
await cp(join(import.meta.dir, "fixtures/action-placement"), source, { recursive: true });
await symlink(join(workspace, "app/node_modules"), join(source, "node_modules"), "dir");
await writeFile(join(source, "tsconfig.json"), JSON.stringify({ extends: join(workspace, "tsconfig.json") }));
build(source);
await mkdir(plugins);
await cp(join(source, "dist"), join(plugins, "ai"), { recursive: true });
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

async function assertCancellation(client) {
  const previous = (await client.query(api.work.rows, {})).rows.length;
  const cancel = new AbortController();
  const action = client.action(api.work.wait, {}, { signal: cancel.signal });
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
  assert.deepEqual(await embedded.action(api.provider.contractCall, {}), { runner: true, depth: 1 });
  assert.deepEqual(await embedded.action(api.delegate.choose, { on: "caller" }), { runner: true, depth: 1 });
  assert.deepEqual(await embedded.action(api.delegate.choose, { on: "server" }), { runner: false, depth: 1 });
  await assertProgram(embedded, api.work.run, 0);
  assert.equal(await embedded.action(api.provider.callLocalContract, {}), 1);
  assert.deepEqual(await embedded.action(api.provider.callServerContract, {}), { runner: true, depth: 1 });
  assert.equal(await embedded.action(api.work.callPrivate, {}), 1);
  await assertCancellation(embedded);
  await assertChannel(embedded);

  const serverPlugins = mode === "--cloud" ? join(scratch, "cloud") : plugins;
  if (mode === "--cloud") {
    await stageServerPlugin(join(source, "dist"), join(serverPlugins, "ai"));
  }
  const shared = Bun.spawn(
    [server, "--plugins", serverPlugins, "--data", join(scratch, "db"), "--listen", "127.0.0.1:0"],
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
  const window = await connect(address, { launch: local.launch, cleanup });
  const browser = await connect(address, { cleanup });

  await assertProgram(window, api.work.run, 0);
  assert.deepEqual(await window.action(api.delegate.caller, {}), { runner: true, depth: 1 });
  assert.deepEqual(await window.action(api.delegate.caller, { override: true }), { runner: true, depth: 1 });
  assert.equal(await window.action(api.work.read, { file }), "text on the caller");
  assert.deepEqual(await window.action(api.work.read, { file }, { on: "server" }), noMachine);
  assert.equal((await browser.query(api.work.rows, {})).rows.length, 1);
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
  assert.deepEqual(
    await within(browser.action(api.work.run, args, { on: "server" }), "server program request", 5000),
    noMachine,
  );
  await local.stop();
  const offlineWindow = await connect(address, { launch: local.launch, cleanup });
  assert.deepEqual(
    await within(offlineWindow.action(api.work.run, args), "Runner unavailable", 5000),
    noMachine,
  );
} finally {
  for (const stop of cleanup.reverse()) await stop();
}
