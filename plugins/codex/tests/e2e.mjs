// Drive the installed Codex provider through chat and ai on a real server.
import assert from "node:assert/strict";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { agentTurns } from "../../../e2e/fake-agent/agent-turn.mjs";
import {
  agentHarness,
  build,
  bunPath,
  connect,
  localLauncher,
  workspace,
} from "../../../e2e/fake-agent/harness.mjs";
import { scanReplays } from "../../../e2e/fake-agent/replay-privacy.mjs";

const real = process.argv[3] === "--real" && !process.env.CI;
if (process.argv[3] && !real) throw new Error("Real Codex tests run locally with --real only.");
await scanReplays("codex");

const h = await agentHarness({ binary: process.argv[2], name: "codex" });
const cleanup = [];
const path = join(h.scratch, "bin");
const status = join(h.home, "codex-status");
const codexHome = join(h.home, ".codex");
const inherited = {
  HOME: h.home,
  PATH: `${path}${delimiter}/usr/bin${delimiter}/bin`,
  CODEX_HOME: codexHome,
};
const module = join(workspace, "plugins/codex");
const editPrompt =
  "Create marker.txt containing exactly tokamak-codex-test followed by a newline. Confirm the text.";
const longPrompt = "Write a long reply containing 100 numbered facts about apples.";
const planPrompt = "Make a concrete plan for adding a second test marker. Do not edit any files.";

try {
  build(module);
  await cp(join(module, "dist"), join(h.plugins, "codex"), { recursive: true });
  if (!real) await replayExecutable();

  const { ai } = h.api;
  const address = await h.serve("server");
  const connectClient = (env) =>
    connect(address, { cleanup, launch: localLauncher((id) => join(h.plugins, id), env) });
  const replayClient = await connectClient(inherited);
  const agentClient = real
    ? await connectClient({
        ...inherited,
        PATH: process.env.PATH,
        CODEX_HOME: process.env.CODEX_HOME || join(homedir(), ".codex"),
      })
    : replayClient;
  const info = async (client) => {
    const codex = (await client.local(ai.agents.list, {})).find((agent) => agent.id === "codex");
    assert.equal(codex?.name, "Codex");
    assert.match(codex.info.install, /@openai\/codex/);
    assert.equal(codex.info.signIn, "codex login");
    return codex.info;
  };

  const missing = await connectClient({ ...inherited, PATH: h.home });
  assert.equal((await info(missing)).installed, false);
  if (real) {
    await mkdir(codexHome);
    const signedOut = await connectClient({ ...inherited, PATH: process.env.PATH });
    const infoOut = await info(signedOut);
    assert.equal(infoOut.installed, true);
    assert.equal(infoOut.signedIn, false);
  } else {
    await writeFile(status, "old\n");
    assert.equal((await info(replayClient)).installed, false);
    await writeFile(status, "signed-out\n");
    assert.equal((await info(replayClient)).signedIn, false);
    await writeFile(status, "prerelease\n");
    assert.equal((await info(replayClient)).signedIn, true);
    await writeFile(status, "signed-in\n");
  }

  const available = await info(agentClient);
  assert.equal(available.installed, true);
  assert.equal(available.signedIn, true);
  assert.ok(available.models[0].efforts.includes("medium"));
  assert.deepEqual(available.modes, ["default", "plan"]);
  const model = available.models[0].id;
  if (!real) {
    assert.equal(model, "gpt-6.2-sol", "the default is first even on page two");
    assert.deepEqual(available.speeds, ["default", "priority"]);
  }

  const turns = agentTurns({
    h,
    client: agentClient,
    agent: { id: "codex", name: "Codex" },
    model,
    effort: "medium",
    timeout: real ? 120_000 : undefined,
  });
  const run = async (tape, prompt, options) => turns.run(await h.folder(tape), prompt, options);
  const recorded = await run(
    "edit",
    real
      ? "Use update_plan to track creating and verifying marker.txt. Run a shell command to create the file with exactly tokamak-codex-test followed by a newline, read it back, then confirm the content."
      : editPrompt,
  );
  assert.ok(recorded.row.sessionId);
  assert.match(recorded.text, /tokamak-codex-test/);
  assert.ok(recorded.reply.usage.inputTokens > 0);
  const editSteps = await recorded.steps();
  assert.ok(editSteps.some((step) => step.state === "done"));
  if (real) {
    assert.equal(await readFile(join(recorded.folder, "marker.txt"), "utf8"), "tokamak-codex-test\n");
  } else {
    assert.equal(recorded.reply.hasThinking, true);
    assert.ok(await recorded.thinking(), "reasoning summary is stored");
    const command = editSteps.find((step) => step.title.includes("cat marker.txt"));
    assert.deepEqual([command?.kind, command?.state], ["command", "done"]);
  }

  const missingSession = "00000000-0000-4000-8000-000000000001";
  const historyFolder = await h.folder("history");
  const historyThread = await turns.seedLostSession(historyFolder, {
    sessionId: missingSession,
    prompt: "Remember the word apricot.",
    text: "I will remember apricot.",
  });
  const recovered = await turns.run(
    historyFolder,
    real ? "What word did I ask you to remember? Reply using just the word." : editPrompt,
    { threadId: historyThread },
  );
  assert.ok(recovered.row.sessionId);
  assert.notEqual(recovered.row.sessionId, missingSession);
  if (real) assert.match(recovered.text, /apricot/i);
  else {
    assert.equal(
      await recovered.thinking(),
      "**Checking unavailable state**\n\nCheck the marker before replying.\n\nReport the verified text.",
    );
    assert.deepEqual(
      (await recovered.steps())
        .filter((step) => step.kind === "edit")
        .map(({ key, title, state }) => ({ key, title, state })),
      [
        { key: "patch-1:marker.txt", title: "marker.txt", state: "done" },
        { key: "patch-1:README.md", title: "README.md", state: "done" },
      ],
      "a patch updates one step per file in the order they started",
    );
    assert.deepEqual(recovered.reply.tasks, [
      { text: "Create the marker", state: "done" },
      { text: "Verify it", state: "running" },
    ]);
  }

  // Continue the real thread, but switch the replay executable's working folder to select the next tape.
  const follow = async (tape, prompt, options) =>
    turns.run(real ? recorded.folder : await h.folder(tape), prompt, {
      ...options,
      threadId: recorded.threadId,
    });
  const planned = await follow("plan", planPrompt, { mode: "plan" });
  assert.equal(planned.row.sessionId, recorded.row.sessionId);
  assert.match(planned.reply.plan, /marker/i);
  if (!real)
    assert.deepEqual(
      planned.reply.usage,
      { inputTokens: 41_839, outputTokens: 240, cachedInputTokens: 39_168 },
      "usage excludes the previous turn's tokens",
    );

  const steerText = "Stop the list and reply exactly: STEERED";
  const steered = await follow("steer", longPrompt, {
    async during(turn) {
      await turn.firstText();
      await turn.steer(steerText);
    },
  });
  assert.match(steered.text, /STEERED/);
  assert.deepEqual(steered.reply.steers, [steerText]);
  if (!real)
    assert.deepEqual(
      steered.reply.usage,
      { inputTokens: 21_781, outputTokens: 7, cachedInputTokens: 21_376 },
      "without an earlier usage notification, the first total is the baseline",
    );
  const stopped = await follow("stop", longPrompt, {
    state: "stopped",
    async during(turn) {
      await turn.firstText();
      await turn.stop();
    },
  });
  assert.equal(stopped.row.sessionId, recorded.row.sessionId);
  if (real) assert.ok(stopped.text, "the partial reply is retained");
  else assert.equal(stopped.text, "1. Apples are");

  if (!real) {
    const earlyFolder = await h.folder("early-stop");
    const early = await turns.run(earlyFolder, longPrompt, {
      threadId: recorded.threadId,
      state: "stopped",
      async during(turn) {
        // Hold the CLI's start response until the real Stop call has reached the adapter.
        await h.waitFor(earlyFolder, "turn-start-pending");
        await turn.stop();
        await h.gate(earlyFolder, "stop-requested");
      },
    });
    assert.equal(early.row.sessionId, recorded.row.sessionId);

    const helperPrompt =
      "Use the built-in subagent tool to launch exactly one explorer. Ask it to reply with only HELPER-OK, without running commands or editing files. Wait for it to finish and tell me its answer. Do not use a shell to launch an agent.";
    const helped = await run("helpers", helperPrompt, { speed: "priority" });
    assert.equal(helped.row.speed, "priority");
    assert.deepEqual(
      helped.reply.helpers.map(({ key, name, title, state, hasText }) => ({
        key,
        name,
        title,
        state,
        hasText,
      })),
      [{ key: "helper-thread", name: "explorer", title: "/root/helper", state: "done", hasText: true }],
    );
    assert.equal(await helped.helper(helped.reply.helpers[0]), "HELPER-OK");
    for (const [tape, access] of [
      ["helper-approval", "ask"],
      ["full-approval", "full"],
    ]) {
      const result = await run(tape, helperPrompt, {
        access,
        answers: access === "ask" ? 1 : 0,
        during:
          access === "ask"
            ? async (turn) => {
                const question = await turn.question();
                assert.match(question.subject, /helper-approval/);
                await turn.answer(question, "approve");
              }
            : undefined,
      });
      assert.equal(result.row.access, access);
      assert.equal(result.reply.helpers[0].state, "done", "the helper ends with the parent turn");
      assert.deepEqual(await result.steps(), [], "the helper's command stays out of the parent reply");
    }
  }

  for (const [tape, answer, allowed] of [
    ["accept", "approve", true],
    ["acceptForSession", "approveSession", true],
    ["decline", "decline", false],
    ["cancel", "cancel", false],
  ]) {
    const file = join(h.home, `approval-${tape}.txt`);
    const result = await run(
      tape,
      `Use a shell command with sandbox_permissions require_escalated to write exactly tokamak-permission to ${file}. The file is outside the current folder. Do not write it any other way or retry if declined. Say what happened.`,
      {
        access: "ask",
        answers: 1,
        state: answer === "cancel" ? "stopped" : "done",
        async during(turn) {
          const question = await turn.question();
          assert.equal(question.action, "run");
          assert.match(question.subject, /tokamak-permission/);
          await turn.answer(question, answer);
        },
      },
    );
    assert.equal(result.row.access, "ask");
    assert.ok(
      (await result.steps()).some(
        (step) => step.title.includes("tokamak-permission") && step.state === (allowed ? "done" : "failed"),
      ),
    );
    if (real)
      assert.equal(
        await stat(file).then(
          () => true,
          () => false,
        ),
        allowed,
      );
  }
  console.log(
    `codex (${real ? "real" : "replay"}): availability, model catalog, reply and session rows, reasoning, tools, plan, usage, steer, stop, four approval decisions`,
  );
} finally {
  for (const stop of cleanup.reverse()) await Promise.resolve(stop()).catch(() => {});
  await h.close();
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

async function replayExecutable() {
  const replay = join(workspace, "e2e/fake-agent/program.mjs");
  await writeFile(
    join(path, "codex"),
    `#!/bin/sh
status=$(cat "$HOME/codex-status")
case "$1" in
  --version)
    case "$status" in
      old) echo 'codex-cli 0.169.0' ;;
      prerelease) echo 'codex-cli 0.171.0-alpha.1' ;;
      *) echo 'codex-cli 0.170.0' ;;
    esac
    ;;
  app-server)
    case "\${PWD##*/}" in
      home)
        if [ "$status" = "signed-out" ]; then tape=signed-out; else tape=info; fi
        ;;
      *) tape="\${PWD##*/}" ;;
    esac
    exec ${shellQuote(bunPath())} ${shellQuote(replay)} --replay "codex/$tape"
    ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
}
