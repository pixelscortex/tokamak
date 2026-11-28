import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import {
  build,
  connect,
  copySource,
  startServer,
  within,
  workspace,
} from "../../../e2e/fake-agent/harness.mjs";
import { startRunner } from "../../../e2e/fake-agent/local.mjs";
import { stageServerPlugin } from "../../build/src/stage-server-plugin.ts";
import { runnerLauncher } from "../../runtime/js/runner.ts";
import { authCaller, createApi } from "../../sdk/src/index.ts";
import { installSignInFixture, signInMember, signInMethod } from "./sign-in-fixture.mjs";

const [server, binary, mode] = process.argv.slice(2);
const serverBuild = mode === "--server-build";
const ownerToken = "runner-routing-owner-token-for-tests";
const id = "fixture-runner-routing";
const api = createApi(id).probe;
const target = join(workspace, "packages/server/target");
await mkdir(target, { recursive: true });
const scratch = await mkdtemp(join(target, "runner-routing-"));
const plugins = join(scratch, "plugins");
const source = join(scratch, "source");
const cleanup = [];
const servers = [];

try {
  await copySource(
    join(import.meta.dir, "fixtures/runner-routing"),
    source,
    join(workspace, "app/node_modules"),
  );
  build(source);
  await cp(join(source, "dist"), join(plugins, id), { recursive: true });
  await installSignInFixture(plugins);

  let pluginsDir = plugins;
  if (serverBuild) {
    pluginsDir = join(scratch, "cloud-plugins");
    for (const plugin of [id, signInMethod]) {
      await stageServerPlugin(join(plugins, plugin), join(pluginsDir, plugin));
    }
  }
  const shared = await startServer({
    binary: server,
    dir: join(scratch, "shared"),
    pluginsDir,
    shared: true,
    ownerToken,
    servers,
    cleanup,
  });
  const http = shared.replace(/^ws:/, "http:");
  const owner = await fetch(new URL("/auth/owner", http), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ deviceName: "Test window" }),
  });
  assert.equal(owner.status, 200, await owner.clone().text());
  const { key: token } = await owner.json();

  if (serverBuild) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: "http://tauri.localhost",
    };
    const installed = await fetch(new URL("/plugins", http), { headers });
    assert.equal(installed.status, 200);
    const catalog = await installed.json();
    assert.deepEqual(catalog.skipped, {});
    assert.deepEqual(catalog.plugins.map(({ plugin }) => plugin.id).sort(), [id, signInMethod]);

    const staged = join(pluginsDir, id);
    const manifest = await Bun.file(join(staged, "manifest.json")).json();
    assert.ok(manifest.entries.local, "the staging probe has local entries");
    for (const localFile of Object.values(manifest.entries.local)) {
      assert.equal(await Bun.file(join(plugins, id, localFile)).exists(), true, localFile);
      assert.equal(await Bun.file(join(staged, localFile)).exists(), false, localFile);
    }

    const workerUrl = new URL("/local-worker", http);
    assert.equal((await fetch(workerUrl)).status, 401);
    const refused = await fetch(workerUrl, {
      headers: {
        Origin: headers.Origin,
        "Sec-WebSocket-Protocol": `tokamak, tokamak.bearer.${token}`,
      },
    });
    assert.equal(refused.status, 501);
    assert.match(await refused.text(), /this server has no local runtime/i);
    const misdirected = runnerLauncher(async () => ({ ws: shared, token }));
    await assert.rejects(
      misdirected(
        {
          id,
          entryHash: manifest.hashes[manifest.entries.local.entry],
          codeHash: manifest.hashes[manifest.entries.local.code],
        },
        () => {},
        () => {},
      ),
      /this server has no local runtime/i,
    );

    const member = await signInMember(shared, ownerToken, "CloudMember");
    assert.ok(member.key);
    console.log(
      "Cloud server: fixture sign-in actions issued a device key; plugin process requests returned 501.",
    );
  }

  const home = join(scratch, "home");
  await mkdir(home);
  const local = await startRunner({
    binary,
    plugins,
    directory: join(scratch, "runner"),
    env: {
      HOME: home,
      TOKAMAK_APP_DATA_DIR: join(scratch, "app-data"),
      ...(serverBuild && {
        TOKAMAK_PLUGIN_HOST: process.env.TOKAMAK_TEST_RUNNER_HOST,
      }),
    },
  });
  cleanup.push(local.stop);
  const requests = [];
  const window = await connect(shared, {
    token,
    cleanup,
    launch: (artifact, receive, closed, workspace) =>
      local.launch(
        artifact,
        (frame) => {
          if (frame.type === "op" && frame.name === "plugin.call") requests.push(frame.payload.kind);
          receive(frame);
        },
        closed,
        workspace,
      ),
  });
  const member = await signInMember(shared, ownerToken, "SecondMember");
  const second = await connect(shared, {
    token: member.key,
    launch: local.launch,
    cleanup,
  });
  const [ownerAuth, memberAuth, ownerFromProvider, memberFromProvider] = await Promise.all([
    window.query(authCaller, {}),
    second.query(authCaller, {}),
    window.action(api.identify, {}),
    second.action(api.identify, {}),
  ]);
  assert.notEqual(ownerAuth.user.id, memberAuth.user.id);
  assert.notEqual(ownerAuth.device.id, memberAuth.device.id);
  assert.deepEqual(ownerFromProvider, ownerAuth);
  assert.deepEqual(memberFromProvider, memberAuth);
  console.log(
    "Two windows on one Runner passed different signed-in members and devices to the same provider.",
  );

  // Seed only the shared store. The local action can return this line only if
  // its query goes back through the window instead of to the Runner's store.
  const otherWindow = await connect(shared, { token, cleanup });
  const runnerWindow = await connect(local.endpoint.ws, {
    token: local.endpoint.token,
    cleanup,
  });
  const line = "Only on the shared server";
  await otherWindow.mutation(api.append, { text: line });
  assert.deepEqual(await runnerWindow.query(api.rows, {}), []);
  requests.length = 0;
  assert.deepEqual(await window.action(api.copyLine, {}), [line]);
  assert.deepEqual((await otherWindow.query(api.rows, {})).sort(), [`Copy of: ${line}`, line]);
  assert.deepEqual(await runnerWindow.query(api.rows, {}), []);
  assert.deepEqual(requests, ["query", "mutation"]);
  console.log(
    "Shared server: a local Runner query read its row and its mutation wrote a copy only on that server.",
  );
} finally {
  for (const stop of cleanup.reverse()) await stop();
  for (const child of servers) {
    child.kill("SIGTERM");
    await within(child.exited, "shared server shutdown");
  }
}
