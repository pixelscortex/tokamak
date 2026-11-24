// Drives the installed Claude provider through a real Tokamak server. CI plays
// sanitized recordings; --live opts into the official CLI on this computer.
import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { permissionCases } from "./permissions.mjs";
import { claudeSnapshots } from "./snapshots.mjs";
import { overlappingHello, resistantTurns } from "./overlap.mjs";
import { turnWire } from "./turn-wire.mjs";
import { turnParity } from "../../../e2e/fake-agent/turn-parity.mjs";
import { agentTurns } from "../../../e2e/fake-agent/agent-turn.mjs";
import { fileURLToPath } from "node:url";
import { agentHarness, build, bunPath, connect } from "../../../e2e/fake-agent/harness.mjs";
import { startRunner } from "../../../e2e/fake-agent/local.mjs";
import { scanReplays } from "../../../e2e/fake-agent/replay-privacy.mjs";

const [binary, mode] = process.argv.slice(2);
const live = mode === "--live";
assert.ok(mode === undefined || live, "Use --live to opt in to the installed Claude CLI");
assert.ok(!live || !process.env.CI, "Real Claude tests are local only");
if (!live) await scanReplays("claude");

const source = fileURLToPath(new URL("../", import.meta.url));
const h = await agentHarness({ binary, name: "claude-turns" });
const { ai } = h.api;
const parity = turnParity(h, "claude");
const wire = turnWire();
const executable = () => join(h.scratch, "bin", "claude");
const cleanup = [];
const hello = "Remember the code word TIDAL. Reply only: Hello Tokamak.";
const recall = "What was the code word? Reply only with the code word.";
const counting =
  "Print the integers from 1 through 1000, with a separate line for each integer. Do not use tools.";
const longCommand =
  "Use Bash to run the exact command sleep 20. Then reply only TOO_LATE. Do not invoke any other tool.";
const todo =
  "Use TodoWrite to create a task called Write fixture, state in_progress. Use Write to create todo-smoke.txt with TOKAMAK_TEST as content. Use an Explore helper to check whether this file exists, without reading other files. Mark the task completed with TodoWrite, then say DONE.";
try {
  await h.assertLocalRuntime();
  build(source);
  await cp(join(source, "dist"), join(h.plugins, "claude"), { recursive: true });
  if (!live) await installReplay();
  const runner = live && binary.split(/[\\/]/).pop()?.startsWith("tokamak-runner");
  const address = runner ? undefined : await h.serve("local");
  const client = live
    ? await realClient(address)
    : await h.connect(address, { local: true, observe: wire.observe });
  const info = () => aboutClaude(client);
  assert.equal((await info())?.signedIn, true, "Claude is listed as signed in");
  const turns = agentTurns({
    h,
    client,
    agent: { id: "claude", name: "Claude" },
    model: "sonnet",
    effort: "low",
    timeout: live ? 120_000 : undefined,
  });
  const run = async (name, prompt, options) => turns.run(await caseFolder(name), prompt, options);
  if (live) {
    const signedOut = await realClient(address, await h.folder("signed-out-profile"));
    assert.deepEqual(readyState(await aboutClaude(signedOut)), [true, false]);
  } else {
    await discovery(client);
    const keychain = join(h.home, "claude-replay-signed-out");
    await writeFile(keychain, "");
    try {
      const failed = await run("signed-out", hello, { state: "failed" });
      assert.equal(
        failed.row.error,
        "Claude is signed out. Sign in, then come back. Run `claude auth login`.",
      );
      assert.deepEqual(readyState(await info()), [true, false]);
    } finally {
      await unlink(keychain);
    }
    assert.deepEqual(readyState(await info()), [true, true]);
  }
  passed("signed-in and signed-out discovery");
  await resume(turns, run);
  passed("reply and resumed session");
  await recover(turns);
  passed("lost session recovery with history");
  const overlap = live ? (_name, exercise) => exercise() : overlappingHello(h, run, hello, parity);
  await overlap("stop-streaming", () => stopStreaming(run));
  passed("stop while streaming");
  await stopRunningTool(run);
  passed("stop while a command runs");
  await steerTurns(run);
  await permissionCases({ h, run, turns, overlap, live, parity, caseFolder, passed });
  if (!live) await resistantTurns({ h, client, hello, overlap, parity, wire });
  await reports(run);
  if (!live) {
    await claudeSnapshots(h, hello);
    await parity.verify();
  }
  console.log(
    `Claude ${live ? "live" : "replay"}: discovery, streaming, storage, resume, steer, stop, permission answers and all report kinds`,
  );
} finally {
  for (const stop of cleanup.reverse()) await stop();
  await h.close();
}

async function aboutClaude(client) {
  return (await client.local(ai.agents.list, {})).find(({ id }) => id === "claude")?.info;
}

function caseFolder(name) {
  return h.folder(`claude-${name}`);
}

async function realClient(address, profile = process.env.CLAUDE_CONFIG_DIR) {
  // These are the client's relevant environment entries. Claude gets any
  // gateway settings from its own profile, not ANTHROPIC_* exports here.
  const env = { HOME: homedir(), ...(profile && { CLAUDE_CONFIG_DIR: profile }) };
  for (const key of [
    "PATH",
    "USER",
    "LANG",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (!address) {
    const dir = await h.folder("live-runners");
    const instance = await startRunner({
      binary,
      plugins: h.plugins,
      directory: join(dir, crypto.randomUUID()),
      env,
    });
    cleanup.push(instance.stop);
    return connect(instance.endpoint.ws, {
      cleanup,
      launch: instance.launch,
      token: instance.endpoint.token,
    });
  }
  return h.connect(address, { local: true, env });
}

async function installReplay() {
  const impl = join(source, "tests/replay.mjs");
  await writeFile(executable(), `#!/bin/sh\nexec "${bunPath()}" "${impl}" "$@"\n`);
  await chmod(executable(), 0o755);
}

async function discovery(client) {
  const info = () => aboutClaude(client);
  const ready = await info();
  assert.equal(ready.installed, true);
  assert.ok(ready.models.find((model) => model.id === "sonnet")?.efforts.includes("high"));
  // Every model Claude offers stays a choice, named by the model it runs: the default (which
  // follows the account) says it is the default, and the alias it points at keeps its own entry.
  assert.deepEqual(
    ready.models.map(({ id, name }) => ({ id, name })),
    [
      { id: "default", name: "Opus 5.5 (default)" },
      { id: "opus", name: "Opus 5.5" },
      { id: "sonnet", name: "Sonnet 5.5" },
      { id: "haiku", name: "Haiku 5.5" },
    ],
  );
  assert.deepEqual(ready.speeds, []);
  const profile = join(h.home, ".claude");
  await mkdir(profile);
  const marker = join(profile, ".credentials.json");
  await writeFile(marker, "signed-out");
  assert.deepEqual(readyState(await info()), [true, false]);
  for (const fixture of ["expired-iso", "expired-ms", "expired-seconds"]) {
    await writeFile(marker, fixture);
    assert.deepEqual(readyState(await info()), [true, false], `Past loginExpiresAt: ${fixture}`);
  }
  await writeFile(marker, "old");
  const old = await info();
  assert.deepEqual(readyState(old), [false, false]);
  assert.equal(old.install, "claude update");
  assert.equal(old.updateRequired, "Claude needs Claude Code 2.1.330 or later.");
  const rejected = await client.local(ai.run.turn, {
    threadId: "unused",
    messageId: "unused",
    folder: h.home,
    agentId: "claude",
  });
  assert.equal(rejected.kind, "NotInstalled");
  assert.equal(rejected.data.updateRequired, old.updateRequired);
  await rename(executable(), executable() + "-held");
  assert.deepEqual(readyState(await info()), [false, false]);
  await rename(executable() + "-held", executable());
  await writeFile(marker, "");
  assert.deepEqual(readyState(await info()), [true, true]);
}

function readyState(info) {
  return [info.installed, info.signedIn];
}

async function resume(turns, run) {
  const first = await run(
    "hello",
    hello,
    live
      ? {}
      : {
          async during(turn) {
            const part = await turn.firstText();
            assert.equal(part.status, "streaming");
            assert.equal(part.parts[0].text, "Hello Tokamak");
            const lastWrite = wire.hold(".");
            try {
              await h.gate(await caseFolder("hello"), "go");
              await lastWrite.pending();
              const saved = await turn.messageUntil(
                "the final text saved while its acknowledgement is held",
                (message) => message.parts[0]?.text === "Hello Tokamak.",
              );
              assert.equal(saved.status, "streaming");
              assert.equal(lastWrite.finishSent(), false);
            } finally {
              lastWrite.release();
            }
          },
        },
  );
  assert.ok(first.row.sessionId);
  if (live) assert.match(first.text, /Hello Tokamak\./);
  else {
    assert.equal(first.text, "Hello Tokamak.");
    assert.equal(first.row.sessionId, "ed0f9193-a023-4ab1-a74c-a8bba2877dc3");
  }

  if (!live) await parity.capture("claude-hello", first);
  const resumed = await turns.run(first.folder, recall, { threadId: first.threadId });
  assert.equal(resumed.row.sessionId, first.row.sessionId);
  assert.equal(resumed.text.trim(), "TIDAL");
  if (!live)
    assert.deepEqual(resumed.reply.usage, {
      inputTokens: 27451,
      cachedInputTokens: 25510,
      outputTokens: 7,
      costUsd: 0.0103275,
    });
  if (!live) await parity.capture("claude-resume", resumed);
}

async function recover(turns) {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const folder = await caseFolder("lost");
  const threadId = await turns.seedLostSession(folder, {
    sessionId,
    prompt: "Remember the code word TIDAL.",
    text: "I will remember.",
  });
  const recovered = await turns.run(folder, recall, { threadId });
  assert.equal(recovered.text.trim(), "TIDAL");
  assert.ok(recovered.row.sessionId);
  assert.notEqual(recovered.row.sessionId, sessionId);
}

function runningCommand(turn) {
  return turn.replyUntil("the running command", (reply) => reply.current?.kind === "command");
}

async function stopStreaming(run) {
  const stopped = await run("stop", counting, {
    state: "stopped",
    async during(turn) {
      await turn.firstText();
      await turn.stop();
    },
  });
  if (live) assert.ok(stopped.text.trim() && !/\b1000\b/.test(stopped.text));
  else assert.equal(stopped.text, "1\n2\n3\n4");
  const usage = stopped.reply.usage;
  assert.ok(usage && usage.outputTokens < 500, "The interrupted result was saved");
  if (!live) await parity.capture("stop-streaming", stopped);
}

async function stopRunningTool(run) {
  const stopped = await run("stop-tools", longCommand, {
    state: "stopped",
    async during(turn) {
      const { current } = await runningCommand(turn);
      if (!live) assert.equal(current.title, "sleep 20");
      await turn.stop();
    },
  });
  assert.ok(
    (await stopped.steps()).some(
      ({ kind, title, state }) => kind === "command" && (live || title === "sleep 20") && state === "done",
    ),
  );
  assert.doesNotMatch(stopped.text, /TOO_LATE/);
  assert.ok(stopped.row.sessionId && stopped.reply.usage);
}

async function steerTurns(run) {
  const steer = "Correction: stop listing numbers and say STEERED. Do not use tools.";
  const steered = await run("steer", counting.replace("1000", "300"), {
    async during(turn) {
      await turn.firstText();
      await turn.steer(steer);
    },
  });
  assert.match(steered.text.trim(), live ? /STEERED$/ : /300STEERED$/);
  assert.deepEqual(steered.reply.steers, [steer]);
  if (!live)
    assert.deepEqual(steered.reply.usage, {
      inputTokens: 55481,
      cachedInputTokens: 55475,
      outputTokens: 607,
      costUsd: 0.0116295,
    });
  if (!live) {
    assert.equal(steered.text, Array.from({ length: 300 }, (_, i) => i + 1).join("\n") + "STEERED");
    await parity.capture("claude-steer", steered);
  }
  passed("steer while streaming");
  const correction = "Correction: only say STEERED. Do not use tools.";
  const merged = await run(
    "steer-tools",
    "Use Bash to run the exact command sleep 3. Then reply only ORIGINAL. Do not invoke any other tool.",
    {
      async during(turn) {
        await runningCommand(turn);
        await turn.steer(correction);
      },
    },
  );
  assert.equal(merged.text.trim(), "STEERED");
  assert.deepEqual(merged.reply.steers, [correction]);
  assert.ok(
    (await merged.steps()).some(
      ({ kind, title, state }) => kind === "command" && (live || title === "sleep 3") && state === "done",
    ),
  );
  passed("steer while a command runs");
}

function passed(name) {
  if (live) console.log(`Claude PASS: ${name}`);
}

async function reports(run) {
  const progress = await run("todo-list", todo, { effort: "high" });
  assert.equal(progress.reply.hasThinking, true);
  const thinking = await progress.thinking();
  if (live) assert.ok(thinking.trim());
  else assert.match(thinking, /^TodoWrite doesn't appear[\s\S]+\n\nTodoWrite isn't available/);
  const steps = await progress.steps();
  assert.ok(steps.some((step) => step.kind === "edit" && step.state === "done"));
  if (!live) assert.ok(!steps.some((step) => step.kind === "command"), "Child steps stay out of the reply");
  assert.deepEqual(progress.reply.tasks, [{ text: "Write fixture", state: "done" }]);
  const helper = progress.reply.helpers.find(({ name }) => name === "Explore");
  assert.equal(helper?.state, "done");
  assert.equal(helper.hasText, true);
  const helperText = await progress.helper(helper);
  if (live) {
    assert.ok(helperText.trim(), "the helper's report can be opened");
    assert.equal(await readFile(join(progress.folder, "todo-smoke.txt"), "utf8"), "TOKAMAK_TEST");
    assert.ok(progress.reply.usage.outputTokens > 0);
  } else {
    assert.match(helperText, /exists/i);
    assert.deepEqual(progress.reply.usage, {
      inputTokens: 201944,
      cachedInputTokens: 192317,
      outputTokens: 1083,
      costUsd: 0.0738192,
    });
    assert.match(progress.text, /^DONE/);
  }
  if (!live) {
    const writes = wire.writes(progress.row._id);
    console.log(`Claude to-do writes: ${writes}`);
    if (h.selection.runtime === "quickjs") assert.ok(writes === 2 || writes === 3);
    else assert.equal(writes, 2);
    await parity.capture("claude-todo", progress);
  }
  passed("thinking, file edit, tasks, helper and usage reports");
  const plan = await run(
    "plan",
    live
      ? "Use EnterPlanMode, write the trivial plan Say hello to Claude’s designated plan file, then present it with ExitPlanMode. Do not edit project files."
      : "Use ExitPlanMode tool to propose the trivial plan: Say hello.",
    {
      access: "ask",
      answers: 1,
      async during(turn) {
        const question = await turn.question();
        assert.equal(question.subject, "the proposed plan");
        await turn.answer(question, "approve");
      },
    },
  );
  assert.match(plan.reply.plan, live ? /say hello/i : /Plan: Say hello/);
  if (!live) await parity.capture("claude-plan", plan);
  passed("plan permission and report");
}
