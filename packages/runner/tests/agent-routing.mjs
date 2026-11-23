import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { build, bunPath, connect, within, workspace } from "../../../e2e/fake-agent/harness.mjs";
import { startRunner } from "../../../e2e/fake-agent/start-runner.ts";
import { createApi } from "../../sdk/src/index.ts";
import { editBundle, inspectHosts, reload, until } from "./support/routing.mjs";

const scratch = await mkdtemp(join(workspace, "target/agent-routing-"));
const plugins = join(scratch, "plugins");
const directory = join(scratch, "runner");
const home = join(scratch, "home");
const bin = join(scratch, "bin");
await Promise.all([mkdir(home), mkdir(bin), mkdir(plugins)]);
for (const id of ["chat", "ai", "claude", "codex"]) {
  const source = join(workspace, "plugins", id);
  const cached = process.env.TOKAMAK_AGENT_FIXTURES && join(process.env.TOKAMAK_AGENT_FIXTURES, id);
  if (!cached || !(await Bun.file(join(cached, "manifest.json")).exists())) {
    build(source);
    await cp(join(source, "dist"), join(plugins, id), { recursive: true });
  } else {
    await cp(cached, join(plugins, id), { recursive: true });
  }
}

const quoted = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
const bun = quoted(bunPath());
await writeFile(
  join(bin, "claude"),
  `#!/bin/sh
exec ${bun} ${quoted(join(workspace, "plugins/claude/tests/replay.mjs"))} "$@"
`,
  { mode: 0o755 },
);
await writeFile(
  join(bin, "codex"),
  `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 0.170.0' ;;
  app-server) exec ${bun} ${quoted(join(workspace, "e2e/fake-agent/program.mjs"))} --replay codex/info ;;
  *) exit 2 ;;
esac
`,
  { mode: 0o755 },
);

const claude = join(plugins, "claude");
const evals = join(scratch, "claude-evaluations");
const crash = join(scratch, "crash-claude");
await editBundle(
  claude,
  `
import { readFile as fixtureRead, writeFile as fixtureWrite } from "node:fs/promises";
if (await fixtureRead(${JSON.stringify(crash)}).then(() => true, () => false))
  throw new Error("Claude startup failure from the routing test");
await fixtureWrite(${JSON.stringify(evals)}, "old\\n", { flag: "a" });
`,
);

const runner = await startRunner({
  binary: process.argv[2],
  plugins,
  directory,
  env: { HOME: home, PATH: [bin, "/usr/bin", "/bin"].join(delimiter), TOKAMAK_PLUGIN_RUNTIME: "quickjs" },
});
const cleanup = [];
const list = createApi("ai").agents.list;
const row = (client) => within(client.local(list, {}), "replayed agent row");
const agent = (agents, id) => {
  const entry = agents.find((item) => item.id === id);
  assert.ok(entry, id + " missing from agent row");
  return entry.info;
};
const evaluationCount = () => readFile(evals, "utf8").then((text) => text.trim().split("\n"));
const sources = new Set();
let holdClaude;
const observed = (artifact, receive, closed, live) => {
  const held = new Set();
  return runner
    .launch(
      artifact,
      (frame) => {
        if (frame.type === "op" && frame.name === "auth.current" && frame.plugin) {
          sources.add(frame.host);
          if (holdClaude && frame.host === "claude") {
            held.add(frame.id);
            holdClaude.resolve();
            holdClaude = undefined;
          }
        }
        receive(frame);
      },
      closed,
      live,
    )
    .then((worker) => ({
      routed: worker.routed,
      route: (id, target, profile) => worker.route(id, target, profile),
      retire: (target, profile, changed) => worker.retire(target, profile, changed),
      close: () => worker.close(),
      send: (frame) =>
        held.delete(frame.id) && frame.type === "opResult" ? Promise.resolve() : worker.send(frame),
    }));
};
const open = () => connect(runner.endpoint.ws, { token: runner.endpoint.token, launch: observed, cleanup });
async function disconnect() {
  for (const close of cleanup.splice(0).reverse()) await close();
}
try {
  const hosts = await inspectHosts(runner);
  const pids = () => Object.fromEntries(hosts().map(({ id, pid }) => [id, pid]));
  let window = await open();
  const both = await row(window);
  for (const id of ["claude", "codex"]) {
    const info = agent(both, id);
    assert.ok(info.installed && info.signedIn && info.models.length > 0, JSON.stringify(info));
  }
  const before = pids();
  assert.deepEqual(Object.keys(before).sort(), ["ai", "claude", "codex"]);
  assert.equal(new Set(Object.values(before)).size, 3);
  assert.deepEqual(
    [...sources].sort(),
    ["claude", "codex"],
    "both info calls must come from provider realms",
  );
  assert.deepEqual(await evaluationCount(), ["old", "old"], "one import in ai, one evaluation in Claude");

  for (let i = 0; i < 3; i++) {
    await disconnect();
    window = await open();
    assert.deepEqual(await row(window), both);
    assert.deepEqual(pids(), before);
  }
  await reload(runner, directory, "claude");
  assert.deepEqual(await row(window), both);
  assert.deepEqual(pids(), before);
  assert.deepEqual(await evaluationCount(), ["old", "old"]);

  const held = (holdClaude = Promise.withResolvers());
  const running = row(window);
  void running.catch(() => {});
  await within(held.promise, "Claude info awaiting its caller");
  await editBundle(claude, `await fixtureWrite(${JSON.stringify(evals)}, "new\\n", { flag: "a" });`);
  await reload(runner, directory, "claude");
  await assert.rejects(running, /Plugin ai: live provider claude changed; local realm retired/);
  await until("retired ai and Claude hosts exit", () =>
    hosts().every(({ pid }) => pid !== before.ai && pid !== before.claude),
  );
  assert.deepEqual(await row(window), both);
  const changed = pids();
  assert.notEqual(changed.ai, before.ai);
  assert.notEqual(changed.claude, before.claude);
  assert.equal(changed.codex, before.codex);
  assert.equal(hosts().length, 3);
  assert.deepEqual(await evaluationCount(), ["old", "old", "old", "new", "old", "new"]);
  console.log(
    "Replay row: ai, Claude and Codex have distinct PIDs; 3 reconnects and a same-bytes reload reused one live import",
  );

  // The old live import still works, while new starts of Claude's own process fail.
  await writeFile(crash, "");
  process.kill(changed.claude, "SIGKILL");
  await until("killed Claude exits", () => !pids().claude);
  for (const delay of [260, 510, 1010]) {
    await Bun.sleep(delay);
    const agents = await row(window);
    assert.equal(agent(agents, "claude").installed, false);
    assert.deepEqual(agent(agents, "codex"), agent(both, "codex"));
  }
  await until("failed Claude start exited", () => !pids().claude);
  const start = performance.now();
  const degraded = await row(window);
  const elapsed = Math.round(performance.now() - start);
  assert.equal(agent(degraded, "claude").installed, false);
  assert.deepEqual(agent(degraded, "codex"), agent(both, "codex"));
  assert.ok(elapsed < 1_500, `agent row waited ${elapsed} ms on Claude's back-off`);
  assert.equal(pids().ai, changed.ai);
  assert.equal(pids().codex, changed.codex);
  await unlink(crash);
  await until("next Claude look recovers", async () => agent(await row(window), "claude").signedIn);
  assert.notEqual(pids().claude, changed.claude);
  console.log(
    `Changed live bytes retired ai with a reason. Crash-looping Claude did not hold up Codex (${elapsed} ms).`,
  );
} finally {
  await disconnect();
  assert.equal(await runner.stop(), 0);
}
