import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { delimiter, join } from "node:path";
import { agentTurns } from "../../../e2e/fake-agent/agent-turn.mjs";
import { agentHarness, connect } from "../../../e2e/fake-agent/harness.mjs";
import { authCaller } from "../../sdk/src/index.ts";
import { startRunner } from "../../../e2e/fake-agent/local.mjs";

const [server, binary] = process.argv.slice(2);
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
  const shared = await h.serve("shared", { shared: true });
  const token = await h.ownerDevice(shared, "Test window");
  const local = await startRunner({
    binary,
    plugins: h.plugins,
    directory: join(h.scratch, "runner"),
    env: { HOME: h.home, PATH: [h.bin, "/usr/bin", "/bin", process.env.PATH].join(delimiter) },
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
