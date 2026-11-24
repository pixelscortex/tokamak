import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, within, workspace } from "../../../e2e/fake-agent/harness.mjs";
import { agentTurns } from "../../../e2e/fake-agent/agent-turn.mjs";
import { startRunner } from "../../../e2e/fake-agent/start-runner.ts";
import { createApi } from "../../sdk/src/index.ts";
import { prepareReplayAgents } from "./support/agents.mjs";
import { editBundle, inspectHosts, reload, until } from "./support/routing.mjs";
import { cleanScratch } from "./support/scratch.mjs";

const scratch = await mkdtemp(join(workspace, "target/agent-routing-"));
try {
  await exercise();
} finally {
  await cleanScratch(scratch);
}

async function exercise() {
  const { plugins, env } = await prepareReplayAgents(scratch);
  const directory = join(scratch, "runner");
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
    env,
  });
  const cleanup = [];
  const ai = createApi("ai");
  const chat = createApi("chat");
  const list = ai.agents.list;
  const row = (client) => within(client.local(list, {}), "replayed agent row");
  const agent = (agents, id) => {
    const entry = agents.find((item) => item.id === id);
    assert.ok(entry, id + " missing from agent row");
    return entry.info;
  };
  const evaluationCount = () => readFile(evals, "utf8").then((text) => text.trim().split("\n"));
  const sources = new Set();
  let holdClaude;
  const observed = (artifact, receive, closed, live, workspace) => {
    const held = new Map();
    return runner
      .launch(
        artifact,
        (frame) => {
          if (frame.type === "op" && frame.name === "auth.current" && frame.plugin) {
            sources.add(frame.host);
            if (holdClaude && frame.host === "claude") {
              const { ready, release } = holdClaude;
              held.set(frame.id, release.promise);
              ready.resolve();
              holdClaude = undefined;
            }
          }
          receive(frame);
        },
        closed,
        live,
        workspace,
      )
      .then((worker) => ({
        routed: worker.routed,
        route: (id, target, profile) => worker.route(id, target, profile),
        retire: (target, profile, changed) => worker.retire(target, profile, changed),
        close: () => worker.close(),
        async send(frame) {
          if (frame.type === "opResult" && held.has(frame.id)) {
            await held.get(frame.id);
            held.delete(frame.id);
          }
          return worker.send(frame);
        },
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

    const hold = (holdClaude = { ready: Promise.withResolvers(), release: Promise.withResolvers() });
    const running = row(window);
    void running.catch(() => {});
    await within(hold.ready.promise, "Claude info awaiting its caller");
    await editBundle(
      claude,
      `await fixtureWrite(${JSON.stringify(evals)}, "new\\n", { flag: "a" });`,
      (code) => {
        const changed = code.replace('id: "claude", name: "Claude"', 'id: "claude", name: "Claude New"');
        assert.notEqual(changed, code, "fixture changed the live provider name");
        return changed;
      },
    );
    await reload(runner, directory, "claude");
    await until("new row used the changed live code", async () =>
      (await row(window)).some(({ id, name }) => id === "claude" && name === "Claude New"),
    );
    assert.ok(
      hosts().some(({ pid }) => pid === before.ai),
      "the admitted call still has its original realm",
    );
    hold.release.resolve();
    assert.deepEqual(await running, both);
    await until("retired ai and Claude hosts exit", () =>
      hosts().every(({ pid }) => pid !== before.ai && pid !== before.claude),
    );
    const changed = pids();
    assert.notEqual(changed.ai, before.ai);
    assert.notEqual(changed.claude, before.claude);
    assert.equal(changed.codex, before.codex);
    assert.equal(hosts().length, 3);
    assert.deepEqual(await evaluationCount(), ["old", "old", "old", "new", "old", "new"]);
    console.log(
      "Replay row: distinct PIDs, reconnects reused one live import, and an admitted lookup drained while new calls used the new code",
    );

    const project = join(scratch, "claude-permit");
    await mkdir(project);
    const turns = agentTurns({
      h: { api: { ai, chat } },
      client: window,
      agent: { id: "claude", name: "Claude New" },
      model: "sonnet",
      effort: "low",
    });
    const turn = await turns.run(
      project,
      "Use Bash exactly once to run the command touch permit-probe.txt. Then give its output.",
      {
        access: "ask",
        answers: 0,
        async during(controls) {
          const question = await controls.question();
          const previous = pids().ai;
          const codex = join(plugins, "codex");
          await editBundle(codex, "// new Codex live provider bytes");
          await reload(runner, directory, "codex");
          // A second window has no local record of the first window's invocation.
          const other = await open();
          await row(other);
          await until(
            "replacement ai running alongside the turn",
            () => hosts().filter(({ id }) => id === "ai").length === 2,
          );
          assert.deepEqual(
            (await other.local(ai.working.list, {})).map(({ turnId }) => turnId),
            [question.turnId],
          );
          const pending = { turnId: question.turnId, questionId: question.id };
          assert.equal(await other.local(ai.run.pending, pending), true);
          assert.equal(await other.local(ai.run.answer, { ...pending, answer: "approve" }), null);
          // An answer sent from the first window must also see that it has settled.
          assert.equal(
            await controls.sendAnswer(question, "approve").then((result) => result.kind),
            "Expired",
          );
          await until("old ai exited after its turn drained", () =>
            hosts().every(({ pid }) => pid !== previous),
          );
        },
      },
    );
    assert.equal(turn.row.state, "done");
    const resistant = join(scratch, "claude-resistant-reload");
    await mkdir(resistant);
    await turns.run(resistant, "Remember the code word TIDAL. Reply only: Hello Tokamak.", {
      state: "stopped",
      async during(controls) {
        await controls.firstText();
        const { _id: turnId } = await controls.replyUntil("resistant turn", () => true);
        const codex = join(plugins, "codex");
        await editBundle(codex, "// another Codex live provider build");
        await reload(runner, directory, "codex");
        const other = await open();
        await row(other);
        await until(
          "replacement ai admitted new calls while the resistant turn ran",
          () => hosts().filter(({ id }) => id === "ai").length === 2,
        );
        assert.equal(await other.local(ai.run.stop, { turnId }), null);
        assert.equal((await other.local(ai.run.forceStop, { turnId })).kind, "TooEarly");
        await until(
          "force-stop deadline",
          async () => (await other.query(ai.turns.forceStopDelay, { turnId })) === 0,
          15_000,
        );
        assert.equal(await other.local(ai.run.forceStop, { turnId }), null);
      },
    });
    await until(
      "force-stopped turn's old realm exits",
      () => hosts().filter(({ id }) => id === "ai").length === 1,
    );

    // The old live import still works, while new starts of Claude's own process fail.
    const beforeCrash = pids();
    await writeFile(crash, "");
    process.kill(beforeCrash.claude, "SIGKILL");
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
    assert.equal(pids().ai, beforeCrash.ai);
    assert.equal(pids().codex, beforeCrash.codex);
    await unlink(crash);
    await until("next Claude look recovers", async () => agent(await row(window), "claude").signedIn);
    assert.notEqual(pids().claude, beforeCrash.claude);
    console.log(
      `Permission answers, Stop and Force stop reached the original realm. Crash-looping Claude did not hold up Codex (${elapsed} ms).`,
    );
    const codex = join(plugins, "codex");
    const staged = join(scratch, "codex");
    await disconnect();
    await rename(codex, staged);
    await reload(runner, directory, "codex");
    window = await open();
    assert.deepEqual(
      (await row(window)).map(({ id }) => id),
      ["claude"],
    );
    const withoutCodex = pids().ai;
    await disconnect();
    await rename(staged, codex);
    await reload(runner, directory, "codex");
    window = await open();
    agent(await row(window), "codex");
    await until("idle ai with old live profile exits after Codex is added", () =>
      hosts().every(({ pid }) => pid !== withoutCodex),
    );
    assert.equal(hosts().filter(({ id }) => id === "ai").length, 1);
    console.log("Adding a live provider with all windows closed reaped the old ai profile.");
  } finally {
    await disconnect();
    assert.equal(await runner.stop(), 0);
  }
}
