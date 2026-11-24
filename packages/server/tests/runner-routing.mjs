import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { starterPlugins } from "../../../app/scripts/starter-plugins.ts";
import { stageServerPlugin } from "../../build/src/stage-server-plugin.ts";
import { agentTurns } from "../../../e2e/fake-agent/agent-turn.mjs";
import { agentHarness, build, connect, workspace } from "../../../e2e/fake-agent/harness.mjs";
import { authCaller } from "../../sdk/src/index.ts";
import { startRunner } from "../../../e2e/fake-agent/local.mjs";
import { runnerLauncher } from "../../runtime/js/runner.ts";

const [server, binary, mode] = process.argv.slice(2);
const serverBuild = mode === "--server-build";
// The old runtime setting must not select Bun on the cloud server.
if (serverBuild) process.env.TOKAMAK_PLUGIN_RUNTIME = "bun";
const h = await agentHarness({ binary: server, name: "runner-routing" });
const cleanup = [];
try {
  // Have the fixture's routed info handler report the identity it actually
  // received. The existing turn below still uses the unmodified live method.
  const fixture = join(h.plugins, "fake-agent");
  const file = join(fixture, "local.js");
  const original = await readFile(file, "utf8");
  const code = original.replace(/signIn: `unlink [^`]+`/, "signIn: JSON.stringify(ctx.auth)");
  assert.notEqual(code, original, "fixture info must record auth");
  const manifestFile = join(fixture, "manifest.json");
  const manifest = await Bun.file(manifestFile).json();
  manifest.hashes["local.js"] = createHash("sha256").update(code).digest("hex");
  await writeFile(file, code);
  await writeFile(manifestFile, JSON.stringify(manifest));
  let pluginsDir = h.plugins;
  if (serverBuild) {
    // The harness installs Chat, AI, and the sign-in provider.
    for (const id of starterPlugins.filter((id) => !["chat", "ai", "basic-auth"].includes(id))) {
      const source = join(workspace, "plugins", id);
      build(source);
      await cp(join(source, "dist"), join(h.plugins, id, "dist"), { recursive: true });
    }
    pluginsDir = join(h.scratch, "cloud-plugins");
    for (const id of await readdir(h.plugins)) {
      const plugin = join(h.plugins, id);
      const source = (await Bun.file(join(plugin, "manifest.json")).exists()) ? plugin : join(plugin, "dist");
      await stageServerPlugin(source, join(pluginsDir, id));
    }
  }
  const shared = await h.serve("shared", { shared: true, pluginsDir });
  const token = await h.ownerDevice(shared, "Test window");
  if (serverBuild) {
    assert.equal(h.selection.runtime, "quickjs");
    const http = shared.replace(/^ws:/, "http:");
    const headers = { Authorization: `Bearer ${token}`, Origin: "http://tauri.localhost" };
    const installed = await fetch(new URL("/plugins", http), { headers });
    assert.equal(installed.status, 200);
    const catalog = await installed.json();
    const ids = catalog.plugins.map(({ plugin }) => plugin.id);
    assert.deepEqual(
      starterPlugins.filter((id) => !ids.includes(id)),
      [],
      JSON.stringify(catalog.skipped),
    );

    const cloudChat = join(pluginsDir, "chat");
    const manifest = await Bun.file(join(cloudChat, "manifest.json")).json();
    for (const localFile of Object.values(manifest.entries.local)) {
      assert.equal(await Bun.file(join(cloudChat, localFile)).exists(), false, localFile);
    }

    const workerUrl = new URL("/local-worker", http);
    assert.equal((await fetch(workerUrl)).status, 401);
    const refused = await fetch(workerUrl, {
      headers: { Origin: headers.Origin, "Sec-WebSocket-Protocol": `tokamak, tokamak.bearer.${token}` },
    });
    assert.equal(refused.status, 501);
    assert.match(await refused.text(), /this server has no local runtime/i);
    const misdirected = runnerLauncher(async () => ({ ws: shared, token }));
    await assert.rejects(
      misdirected(
        {
          id: "chat",
          entryHash: manifest.hashes[manifest.entries.local.entry],
          codeHash: manifest.hashes[manifest.entries.local.code],
        },
        () => {},
        () => {},
      ),
      /this server has no local runtime/i,
    );

    // Create an account and use the starter sign-in actions on the cloud server.
    const member = await h.signInMember(shared, "runner-routing");
    assert.ok(member.key);
    console.log(
      "Cloud server: starter sign-in actions issued a device key; local worker requests returned 501.",
    );
  }
  const local = await startRunner({
    binary,
    plugins: h.plugins,
    directory: join(h.scratch, "runner"),
    env: {
      HOME: h.home,
      PATH: [h.bin, "/usr/bin", "/bin", process.env.PATH].join(delimiter),
      ...(serverBuild && {
        TOKAMAK_PLUGIN_RUNTIME: undefined,
        TOKAMAK_PLUGIN_HOST: process.env.TOKAMAK_TEST_RUNNER_HOST,
      }),
    },
  });
  cleanup.push(local.stop);
  const requests = [];
  const window = await connect(shared, {
    token,
    cleanup,
    launch: (artifact, receive, closed, live, workspace) =>
      local.launch(
        artifact,
        (frame) => {
          if (frame.type === "op") requests.push(frame.name);
          receive(frame);
        },
        closed,
        live,
        workspace,
      ),
  });
  if (h.selection.runtime === "quickjs") {
    const member = await h.signInMember(shared, "SecondMember");
    const second = await connect(shared, { token: member.key, launch: local.launch, cleanup });
    const identity = (client) => client.query(authCaller, {});
    const inProvider = async (client) =>
      JSON.parse(
        (await client.local(h.api.ai.agents.list, {})).find(({ id }) => id === "fake-agent").info.signIn,
      );
    const [ownerAuth, memberAuth, ownerFromProvider, memberFromProvider] = await Promise.all([
      identity(window),
      identity(second),
      inProvider(window),
      inProvider(second),
    ]);
    assert.notEqual(ownerAuth.user.id, memberAuth.user.id);
    assert.notEqual(ownerAuth.device.id, memberAuth.device.id);
    assert.deepEqual(ownerFromProvider, ownerAuth);
    assert.deepEqual(memberFromProvider, memberAuth);
    console.log(
      "Two windows on one Runner passed different signed-in members and devices to the same provider.",
    );
  }
  const agent = { id: "fake-agent", name: "Fake agent" };
  const turns = agentTurns({ h, client: window, agent, model: "echo", effort: "low" });
  const folder = await h.folder("machine");
  await h.gate(folder, "go");
  const result = await turns.run(folder, "Read this shared thread and reply through the local Runner.");
  const otherWindow = await connect(shared, { token, cleanup });
  const runnerWindow = await connect(local.endpoint.ws, { token: local.endpoint.token, cleanup });
  const args = { threadId: result.threadId };
  assert.equal((await otherWindow.query(h.api.ai.turns.list, args))[0]._id, result.row._id);
  assert.deepEqual(await runnerWindow.query(h.api.ai.turns.list, args), []);
  assert.match(result.text, /Read this shared thread and reply through the local Runner/);
  assert.ok(requests.includes("local.runQuery"), JSON.stringify(requests));
  assert.ok(requests.includes("local.runMutation"), JSON.stringify(requests));
  console.log(
    "Shared server: a local Runner query read its thread and its mutations stored the turn only on that server.",
  );
} finally {
  for (const stop of cleanup.reverse()) await stop();
  await h.close();
}
