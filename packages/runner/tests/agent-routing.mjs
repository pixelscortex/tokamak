import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, within, workspace } from "../../../e2e/fake-agent/harness.mjs";
import { agentTurns } from "../../../e2e/fake-agent/agent-turn.mjs";
import { startRunner } from "../../../e2e/fake-agent/start-runner.ts";
import { createApi } from "../../sdk/src/index.ts";
import { prepareReplayAgents } from "./support/agents.mjs";
import { editBundle, inspectHosts, reload, until } from "./support/routing.mjs";
import { cleanScratch } from "./support/scratch.mjs";

const scratch = await mkdtemp(join(workspace, "target/agent-routing-"));
const helloClaude = "Remember the code word TIDAL. Reply only: Hello Tokamak.";
const helloCodex = "Reply only: Hello from Codex.";
const permit = "Use Bash exactly once to run the command touch permit-probe.txt. Then give its output.";
const remember =
  "Use Bash to run the exact command touch remember-probe.txt twice as two separate consecutive tool calls, never in parallel and never chained. Both calls must be issued before answering. Then reply DONE.";
try {
  await exercise();
} finally {
  await cleanScratch(scratch);
}

function processInfo(pid) {
  const [parent, state] = Bun.spawnSync(["ps", "-o", "ppid=,stat=", "-p", String(pid)])
    .stdout.toString()
    .trim()
    .split(/\s+/);
  return state && !state.startsWith("Z") ? Number(parent) : undefined;
}

async function exercise() {
  const { plugins, env } = await prepareReplayAgents(scratch);
  const directory = join(scratch, "runner");
  const claude = join(plugins, "claude");
  const codex = join(plugins, "codex");
  const evals = join(scratch, "claude-evaluations");
  const crash = join(scratch, "crash-claude");
  await editBundle(
    claude,
    `
import { readFile as fixtureRead, writeFile as fixtureWrite } from "node:fs/promises";
if (await fixtureRead(${JSON.stringify(crash)}).then(() => true, () => false))
  throw new Error("Claude startup failure from the routing test");
await fixtureWrite(${JSON.stringify(evals)}, "evaluated\\n", { flag: "a" });
`,
  );

  const runner = await startRunner({ binary: process.argv[2], plugins, directory, env });
  const cleanup = [];
  const ai = createApi("ai");
  const chat = createApi("chat");
  const open = () =>
    connect(runner.endpoint.ws, { token: runner.endpoint.token, launch: runner.launch, cleanup });
  const row = (client) => within(client.local(ai.agents.list, {}), "replayed agent row");
  const agent = (agents, id) => {
    const entry = agents.find((item) => item.id === id);
    assert.ok(entry, id + " missing from agent row");
    return entry.info;
  };
  const folder = async (...parts) => {
    const path = join(scratch, ...parts);
    await mkdir(path, { recursive: true });
    return path;
  };
  try {
    const hosts = await inspectHosts(runner);
    const pids = () => Object.fromEntries(hosts().map(({ id, pid }) => [id, pid]));
    const window = await open();
    const both = await row(window);
    for (const id of ["claude", "codex"]) {
      const info = agent(both, id);
      assert.ok(info.installed && info.signedIn && info.models.length > 0, JSON.stringify(info));
    }
    const before = pids();
    assert.deepEqual(Object.keys(before).sort(), ["ai", "claude", "codex"]);
    assert.equal(new Set(Object.values(before)).size, 3);
    assert.equal(await readFile(evals, "utf8"), "evaluated\n", "ai did not import Claude's bundle");
    const otherWindow = await open();
    assert.deepEqual(await row(otherWindow), both);
    assert.deepEqual(pids(), before);

    const turns = (id, name, model, effort) =>
      agentTurns({ h: { api: { ai, chat } }, client: window, agent: { id, name }, model, effort });
    const claudeTurns = turns("claude", "Claude", "sonnet", "low");
    const codexTurns = turns("codex", "Codex", "gpt-6.2-sol", "medium");
    const claudeFolder = await folder("claude-hello-parallel");
    const codexFolder = await folder("parallel", "linked-hello");

    // Both CLIs stop at a gate after their first text, before usage and completion.
    function paused(agent, project, prompt) {
      const ready = Promise.withResolvers();
      const release = Promise.withResolvers();
      const result = agent.run(project, prompt, {
        async during(control) {
          await control.firstText();
          ready.resolve();
          await release.promise;
          await writeFile(join(project, "go"), "");
        },
      });
      void result.catch(ready.reject);
      return { result, ready: ready.promise, release: release.resolve };
    }
    const cliPid = async (project, id) => Number(await readFile(join(project, id + ".pid"), "utf8"));
    function codexReply(completed) {
      assert.equal(completed.text, "Hello from Codex.");
      assert.equal(completed.row.sessionId, "codex-session");
      assert.deepEqual(completed.reply.usage, { inputTokens: 18208, cachedInputTokens: 0, outputTokens: 54 });
    }

    const c = paused(claudeTurns, claudeFolder, helloClaude);
    const d = paused(codexTurns, codexFolder, helloCodex);
    try {
      await within(Promise.all([c.ready, d.ready]), "both agent turns streaming");
      const claudePid = await cliPid(claudeFolder, "claude");
      const codexPid = await cliPid(codexFolder, "codex");
      assert.equal(processInfo(claudePid), before.claude);
      assert.equal(processInfo(codexPid), before.codex);
      console.log(
        `Replay CLI parents: Claude ${claudePid} → ${before.claude}; Codex ${codexPid} → ${before.codex}; ai ${before.ai}.`,
      );
      await editBundle(codex, "// new independent Codex build");
      await reload(runner, directory, "codex");
      assert.deepEqual(await row(otherWindow), both);
      assert.equal(pids().ai, before.ai);
      assert.equal(processInfo(claudePid), before.claude);
      assert.equal(processInfo(codexPid), before.codex, "already admitted start stayed on its host");
    } finally {
      c.release();
      d.release();
    }
    const [completedClaude, completedCodex] = await Promise.all([c.result, d.result]);
    assert.equal(completedClaude.text, "Hello Tokamak.");
    assert.equal(completedClaude.row.sessionId, "ed0f9193-a023-4ab1-a74c-a8bba2877dc3");
    assert.deepEqual(completedClaude.reply.usage, {
      inputTokens: 27422,
      cachedInputTokens: 27420,
      outputTokens: 11,
      costUsd: 0.002856,
    });
    codexReply(completedCodex);
    assert.notEqual(completedClaude.threadId, completedCodex.threadId);
    assert.equal(await readFile(evals, "utf8"), "evaluated\n", "turns did not evaluate Claude in ai");
    await until("reloaded Codex's old process drained", () =>
      hosts().every(({ pid }) => pid !== before.codex),
    );

    const grantFolder = await folder("claude-remember");
    const approved = await claudeTurns.run(grantFolder, remember, {
      access: "ask",
      answers: 1,
      async during(control) {
        const question = await control.question();
        await control.answer(question, "approveSession");
        assert.equal((await control.sendAnswer(question, "decline")).kind, "Expired");
      },
    });
    await editBundle(claude, "// new independent Claude build");
    await reload(runner, directory, "claude");
    const resumed = await claudeTurns.run(grantFolder, "Try the same command again.", {
      threadId: approved.threadId,
      access: "ask",
    });
    assert.equal(resumed.row.sessionId, approved.row.sessionId);
    assert.equal(resumed.text, approved.text);
    assert.equal(pids().ai, before.ai);
    await until("reloaded Claude's old process drained", () =>
      hosts().every(({ pid }) => pid !== before.claude),
    );

    const isolatedFolder = await folder("crash-overlap", "linked-hello");
    const resistant = await folder("claude-resistant-crash");
    const isolated = paused(codexTurns, isolatedFolder, helloCodex);
    let tree;
    try {
      await within(isolated.ready, "Codex is streaming when Claude crashes");
      const failed = await claudeTurns.run(resistant, helloClaude, {
        state: "failed",
        async during(control) {
          await control.firstText();
          const treeFile = join(resistant, "process-tree.json");
          await until("replay creates its resistant tree", () => Bun.file(treeFile).exists());
          tree = await Bun.file(treeFile).json();
          assert.ok(tree.every((pid) => processInfo(pid)));
          process.kill(pids().claude, "SIGKILL");
        },
      });
      assert.match(failed.row.error, /Plugin claude process:/);
      await until("Claude host crash reaps its programs", () => !tree.some((pid) => processInfo(pid)));
      assert.ok(processInfo(await cliPid(isolatedFolder, "codex")));
    } finally {
      isolated.release();
    }
    codexReply(await isolated.result);
    assert.equal(pids().ai, before.ai);
    console.log(
      "Both replies had independent text, usage and sessions. Reload kept ai and its session grants. Claude crashed without ending Codex.",
    );

    await until("a subsequent Claude can start", async () => agent(await row(window), "claude").signedIn);
    const questionFolder = await folder("claude-permit");
    let expired;
    await assert.rejects(
      claudeTurns.run(questionFolder, permit, {
        access: "ask",
        async during(control) {
          const question = await control.question();
          expired = { turnId: question.turnId, questionId: question.id };
          const cliPid = hosts().find(({ id }) => id === "claude").pid;
          const children = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="])
            .stdout.toString()
            .split("\n")
            .map((line) => /^\s*(\d+)\s+(\d+)\s+.*\/claude\/tests\/replay\.mjs -p\b/.exec(line))
            .filter((match) => match && Number(match[2]) === cliPid)
            .map((match) => Number(match[1]));
          assert.equal(children.length, 1);
          process.kill(pids().ai, "SIGKILL");
          await until(
            "ai crash cancels the waiting program in Claude's host",
            () => !children.some((pid) => processInfo(pid)),
          );
          assert.equal(processInfo(cliPid) !== undefined, true, "Claude's host survived ai");
        },
      }),
      /Plugin ai process:/,
    );
    assert.equal(await otherWindow.local(ai.run.pending, expired), false);
    assert.equal((await otherWindow.local(ai.run.answer, { ...expired, answer: "approve" })).kind, "Expired");
    console.log(
      "Killing ai expired its open question and reaped its Claude program; the Claude host survived.",
    );

    // Routed discovery still skips a failed provider without stalling working ones.
    assert.deepEqual(await row(otherWindow), both);
    const crashed = pids().claude;
    await writeFile(crash, "");
    process.kill(crashed, "SIGKILL");
    await until("killed Claude exits", () => !pids().claude);
    for (const delay of [260, 510, 1010]) {
      await Bun.sleep(delay);
      const agents = await row(otherWindow);
      assert.equal(agent(agents, "claude").installed, false);
      assert.deepEqual(agent(agents, "codex"), agent(both, "codex"));
    }
    await unlink(crash);
    await until(
      "Claude recovers from its backoff",
      async () => agent(await row(otherWindow), "claude").signedIn,
    );
  } finally {
    for (const close of cleanup.reverse()) await close();
    assert.equal(await runner.stop(), 0);
  }
}
