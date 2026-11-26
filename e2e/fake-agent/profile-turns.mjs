import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isFailure } from "../../packages/sdk/src/index.ts";
import { startFakeCompanies } from "../../plugins/agent-proxy/tests/fake-companies/index.ts";
import { api } from "../../plugins/ai-profiles/src/server/_generated/api.ts";
import { agentTurns } from "./agent-turn.mjs";
import { build, workspace } from "./harness.mjs";
import { installAgentFixture } from "./launch-settings.mjs";

const model = "claude-sonnet-4-6";

function success(result) {
  assert.ok(!isFailure(result), result?.data?.message ?? result?.kind);
  return result;
}

export async function checkProfileTurns(h) {
  for (const id of ["agent-proxy", "ai-profiles"]) {
    build(join(workspace, "plugins", id));
    await cp(join(workspace, "plugins", id, "dist"), join(h.plugins, id), { recursive: true });
  }
  const manifestPath = join(h.plugins, "agent-proxy/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.plugin.permissions.push("net:127.0.0.1");
  await writeFile(manifestPath, JSON.stringify(manifest));

  await installAgentFixture(
    h,
    "recording-claude",
    `
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { action, provide } from "@tokamak/sdk";
import { agent, type Info, type Run } from "plugin:ai/contracts";
const info = action({
  on: "caller",
  handler: async (): Promise<Info> => ({
    installed: true, signedIn: true, install: "", signIn: "",
    models: [{ id: "claude-sonnet-4-6", name: "Sonnet", efforts: ["low", "high"] }], speeds: [], modes: [],
  }),
});
const start = action({
  on: "caller",
  handler: async (_ctx, run: Run) => {
    let stopped = false;
    run.onStop(() => { stopped = true; });
    await writeFile(join(run.folder, "received.json"), JSON.stringify(run.launchSettings ?? null));
    if (run.prompt === "wait" || run.prompt === "stop") {
      run.text("Ready");
      while (!stopped && (await readFile(join(run.folder, "go")).catch(() => null)) === null)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (run.prompt === "fail") throw new Error("Recording agent failed.");
    return stopped ? { sessionId: "test", stopped: true as const } : { sessionId: "test" };
  },
});
export default provide(agent, { id: "claude", name: "Recording Claude", info, start });
`,
  );

  const fake = await startFakeCompanies({ delayMs: 1 });
  try {
    const address = await h.serve("profile-turns", {
      env: { TOKAMAK_AGENT_PROXY_ADDRESSES: JSON.stringify(fake.addresses) },
    });
    const client = await h.connect(address);
    const { chat, ai } = h.api;
    const turns = agentTurns({ h, client, agent: { id: "claude", name: "Recording Claude" }, model });
    const profiles = api.profiles;
    const picks = api["thread-profiles"];
    const picked = (thread) => client.query(picks.selection, { thread });
    const pick = async (profile, thread) =>
      success(await client.mutation(picks.pick, { profile, ...(thread && { thread }) }));
    const receive = async (folder) => JSON.parse(await readFile(join(folder, "received.json"), "utf8"));
    const proxy = async (settings) => {
      const { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key } = settings.env;
      assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/plugins\/agent-proxy\//);
      assert.equal(key.length, 43);
      return fetch(base + "/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hello" }] }),
      });
    };
    const ended = async (settings) => {
      const response = await proxy(settings);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.message, "Turn key has ended.");
    };
    const upstream = async (settings, account) => {
      const response = await proxy(settings);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /event: message_stop/);
      assert.equal(
        fake.requests.filter(({ path }) => path.startsWith("/anthropic/v1/messages")).at(-1).account,
        account,
      );
    };

    const normal = await turns.run(await h.folder("profile-personal"), "normal");
    assert.equal(await receive(normal.folder), null);

    async function subscribe(account) {
      fake.addAccount("anthropic", account);
      const pending = success(
        await client.action(api.subscriptions.startSignIn, {
          company: "anthropic",
          method: "subscription",
        }),
      );
      fake.nextSignIn(account);
      const page = await fetch(pending.link, { redirect: "manual" });
      return success(
        await client.action(api.subscriptions.finishSignIn, {
          id: pending.id,
          pasted: page.headers.get("location"),
        }),
      );
    }
    const alpha = success(await client.mutation(profiles.create, { name: "Alpha", code: "ALPH" }));
    const beta = success(await client.mutation(profiles.create, { name: "Beta", code: "BETA" }));
    const alice = await subscribe("alice");
    const bob = await subscribe("bob");
    for (const [profile, subscription] of [
      [alpha, alice],
      [beta, bob],
    ]) {
      success(await client.mutation(profiles.add, { profile: profile.id, subscription: subscription.id }));
    }

    const blocked = await turns.run(await h.folder("profile-unpicked"), "blocked", { state: "failed" });
    assert.equal(blocked.error, "Pick a profile to send.");
    assert.equal(await Bun.file(join(blocked.folder, "received.json")).exists(), false);

    async function thread(name, profile) {
      await pick(profile.id);
      const folder = await h.folder(name);
      const started = await client.mutation(chat.threads.start, {
        text: "setup",
        folder: { kind: "chosen", path: folder },
      });
      assert.equal((await picked(started.threadId)).code, profile.code);
      return { threadId: started.threadId, folder };
    }
    const a = await thread("profile-alpha", alpha);
    const b = await thread("profile-beta", beta);
    const catalog = await client.action(ai.agents.list, { threadId: a.threadId });
    assert.deepEqual(
      catalog.map(({ id }) => id),
      ["claude"],
    );
    assert.ok(catalog[0].info.models.some(({ id }) => id === model));
    assert.ok((await client.action(ai.agents.list, {})).some(({ id }) => id === "fake-agent"));

    await turns.run(a.folder, "check", { threadId: a.threadId });
    await ended(await receive(a.folder));

    let announceA, announceB;
    const readyA = new Promise((resolve) => (announceA = resolve));
    const readyB = new Promise((resolve) => (announceB = resolve));
    async function hold(thread, announce) {
      return turns.run(thread.folder, "wait", {
        threadId: thread.threadId,
        async during(control) {
          await control.firstText();
          announce(await receive(thread.folder));
        },
      });
    }
    const both = [hold(a, announceA), hold(b, announceB)];
    const [settingsA, settingsB] = await Promise.race([Promise.all([readyA, readyB]), Promise.race(both)]);
    assert.notEqual(settingsA.env.ANTHROPIC_AUTH_TOKEN, settingsB.env.ANTHROPIC_AUTH_TOKEN);
    await upstream(settingsA, "alice");
    await upstream(settingsB, "bob");

    success(await client.mutation(profiles.add, { profile: alpha.id, subscription: bob.id, at: 0 }));
    success(await client.mutation(api.subscriptions.setEnabled, { id: alice.id, enabled: false }));
    await upstream(settingsA, "alice");
    await upstream(settingsB, "bob");
    await Promise.all([h.gate(a.folder, "go"), h.gate(b.folder, "go")]);
    await Promise.all(both);
    await Promise.all([ended(settingsA), ended(settingsB)]);

    await h.closeGate(a.folder, "go");
    let stoppedKey;
    await turns.run(a.folder, "stop", {
      threadId: a.threadId,
      state: "stopped",
      async during(control) {
        await control.firstText();
        stoppedKey = await receive(a.folder);
        await upstream(stoppedKey, "bob");
        await control.stop();
      },
    });
    await ended(stoppedKey);
    await pick(alpha.id, b.threadId);
    assert.equal((await picked(b.threadId)).code, "ALPH");
    await turns.run(b.folder, "fail", { threadId: b.threadId, state: "failed" });
    await ended(await receive(b.folder));

    await client.mutation(chat.threads.remove, { threadId: a.threadId });
    assert.equal(await picked(a.threadId), null);
    const uses = await client.query(api.manage.usedBy, { id: alice.id });
    assert.equal(uses.find(({ id }) => id === alpha.id).threads, 1);
    await client.mutation(profiles.discard, { profile: alpha.id });
    assert.equal(await picked(b.threadId), null);
    assert.equal(await client.query(picks.selection, {}), null);
    process.stdout.write(
      "PASS profile turns: personal login, required pick, catalog, concurrent account isolation, snapshot, stop/failure cleanup, thread cascade and profile deletion\n",
    );
  } finally {
    await fake.stop();
  }
}
