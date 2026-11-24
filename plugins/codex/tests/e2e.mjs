// Drive the installed Codex provider through chat and ai on a real server.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { agentTurns } from "../../../e2e/fake-agent/agent-turn.mjs";
import { agentHarness, build, bunPath, connect, workspace } from "../../../e2e/fake-agent/harness.mjs";
import { startRunner } from "../../../e2e/fake-agent/local.mjs";
import { scanReplays } from "../../../e2e/fake-agent/replay-privacy.mjs";

const real = process.argv[3] === "--real" && !process.env.CI;
if (process.argv[3] && !real) throw new Error("Real Codex tests run locally with --real only.");
await scanReplays("codex");

const h = await agentHarness({ binary: process.argv[2], name: "codex" });
const cleanup = [];
const path = join(h.scratch, "bin");
const codexHome = join(h.home, ".codex");
const status = join(codexHome, "auth.json");
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
  await h.assertLocalRuntime();
  build(module);
  await cp(join(module, "dist"), join(h.plugins, "codex"), { recursive: true });
  if (!real) await replayExecutable();

  const { ai } = h.api;
  const binary = process.argv[2];
  const runner = binary.split(/[\\/]/).pop()?.startsWith("tokamak-runner");
  const address = runner ? undefined : await h.serve("server");
  const connectClient = async (env) => {
    if (address) return h.connect(address, { local: true, env });
    const dir = await h.folder("runners");
    const instance = await startRunner({
      binary,
      plugins: h.plugins,
      directory: join(dir, crypto.randomUUID()),
      env: { ...env, TOKAMAK_OWNER_NAME: "Sam" },
    });
    cleanup.push(instance.stop);
    return connect(instance.endpoint.ws, {
      cleanup,
      launch: instance.launch,
      token: instance.endpoint.token,
    });
  };
  const replayClient = real ? undefined : await connectClient(inherited);
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

  const missingPath = runner ? await missingCodexPath() : h.home;
  const missing = await connectClient({ ...inherited, PATH: missingPath });
  assert.equal((await info(missing)).installed, false);
  passed("missing Codex reports not installed");
  if (real) {
    await mkdir(codexHome);
    const signedOut = await connectClient({ ...inherited, PATH: process.env.PATH });
    const infoOut = await info(signedOut);
    assert.equal(infoOut.installed, true);
    assert.equal(infoOut.signedIn, false);
  } else {
    await mkdir(codexHome);
    await writeFile(status, "old\n");
    assert.equal((await info(replayClient)).installed, false);
    await writeFile(status, "signed-out\n");
    assert.equal((await info(replayClient)).signedIn, false);
    await writeFile(status, "prerelease\n");
    assert.equal((await info(replayClient)).signedIn, true);
    // A positive discovery answer was just cached. Changing the credential
    // file must make the same provider notice that the account signed out.
    await writeFile(status, "signed-out\n");
    assert.equal((await info(replayClient)).signedIn, false);
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
  passed("availability and model catalog");

  const turns = agentTurns({
    h,
    client: agentClient,
    agent: { id: "codex", name: "Codex" },
    model,
    effort: "medium",
    timeout: real ? 120_000 : undefined,
  });
  const run = async (tape, prompt, options) => turns.run(await h.folder(tape), prompt, options);

  const greeting = !real && (await run("hello", "Reply only: Hello from Codex."));
  if (greeting) {
    assert.equal(await readFile(join(greeting.folder, "session-flushed"), "utf8"), "flushed");
    assert.equal(greeting.text, "Hello from Codex.");
    assert.equal(greeting.row.sessionId, "codex-session");
    assert.deepEqual(greeting.reply.usage, { inputTokens: 18208, cachedInputTokens: 0, outputTokens: 54 });
  }

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
  passed("edit, reply, reports and session");

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
  passed("lost session recovery with history");

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
  passed("resumed session and plan");

  const steerText = "Stop the list and reply exactly: STEERED";
  const driveSteer = real
    ? follow
    : (tape, prompt, options) => run(tape, prompt, { ...options, threadId: greeting.threadId });
  const steered = await driveSteer("steer", longPrompt, {
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
  if (!real) {
    assert.equal(steered.text, "1. TheSTEERED");
    assert.equal(steered.row.sessionId, greeting.row.sessionId);
  }
  passed("steer while streaming");
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
  passed("stop while streaming");

  const helperPrompt =
    "Use the built-in subagent tool to launch exactly one explorer. Ask it to reply with only HELPER-OK, without running commands or editing files. Wait for it to finish and tell me its answer. Do not use a shell to launch an agent.";
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
    const full = await run("full-approval", helperPrompt, { access: "full" });
    assert.equal(full.row.access, "full");
    assert.equal(full.reply.helpers[0].state, "done", "the helper ends with the parent turn");
    assert.deepEqual(await full.steps(), [], "the helper's command stays out of the parent reply");
  }

  for (const [tape, answer, allowed] of [
    ["accept", "approve", true],
    ["acceptForSession", "approveSession", true],
    ["decline", "decline", false],
    ["cancel", "cancel", false],
  ]) {
    const folder = await h.folder(tape);
    const edit = tape === "accept";
    const original = "unchanged\n";
    const commandText = "tokamak-permission";
    const marker = join(folder, "existing.txt");
    await writeFile(marker, original);
    async function checkFolder(files, contents) {
      assert.deepEqual((await readdir(folder)).sort(), files);
      assert.equal(await readFile(marker, "utf8"), contents);
    }
    const command =
      "Use the shell tool once to run `printf %s tokamak-permission > command.txt` in the current folder. Do not use an escalated sandbox or any substitute tool. If declined, do not retry. Then report the outcome.";
    const result = await turns.run(
      folder,
      edit
        ? `First use the native apply_patch tool to replace the only line in existing.txt (unchanged) with patched. Do not use the shell for the edit. Then: ${command}`
        : command,
      {
        access: "ask",
        answers: edit ? 2 : 1,
        state: answer === "cancel" ? "stopped" : "done",
        async during(turn) {
          if (edit) {
            const question = await turn.question();
            assert.equal(question.action, "edit");
            await checkFolder(["existing.txt"], original);
            await turn.answer(question, "approve");
          }
          const question = await turn.question();
          assert.equal(question.action, "run");
          assert.match(question.subject, /command\.txt/);
          await checkFolder(["existing.txt"], edit ? "patched\n" : original);
          await turn.answer(question, answer);
        },
      },
    );
    assert.equal(result.row.access, "ask");
    const steps = await result.steps();
    if (edit)
      assert.ok(
        steps.some(
          ({ kind, title, state }) => kind === "edit" && title.endsWith("existing.txt") && state === "done",
        ),
      );
    assert.ok(
      steps.some(
        ({ kind, title, state }) =>
          kind === "command" && title.includes("command.txt") && state === (allowed ? "done" : "failed"),
      ),
    );
    await checkFolder(
      allowed ? ["command.txt", "existing.txt"] : ["existing.txt"],
      edit ? "patched\n" : original,
    );
    if (allowed) assert.equal(await readFile(join(folder, "command.txt"), "utf8"), commandText);
    passed(tape === "accept" ? "approve a file edit and a writing command" : tape);
  }

  const helped = await run(
    "helper-approval",
    "Use the built-in subagent tool to launch exactly one helper named helper. Ask it to run the shell command `printf %s helper-approval > helper.txt` in this same folder, then report completion. Wait for the helper to finish and report its result. Do not run a shell command or edit files yourself.",
    {
      access: "ask",
      answers: 1,
      async during(turn) {
        const question = await turn.question();
        assert.equal(question.action, "run");
        assert.match(question.subject, /helper\.txt/);
        await turn.answer(question, "approve");
      },
    },
  );
  assert.equal(helped.row.access, "ask");
  assert.equal(helped.reply.helpers.length, 1);
  assert.equal(helped.reply.helpers[0].state, "done");
  assert.deepEqual(await helped.steps(), [], "the helper's command stays out of the parent reply");
  assert.equal(await readFile(join(helped.folder, "helper.txt"), "utf8"), "helper-approval");
  passed("helper approval");
  console.log(
    `codex (${real ? "real" : "replay"}): availability, model catalog, reply and session rows, reasoning, tools, plan, usage, steer, stop, four approval decisions`,
  );
} finally {
  for (const stop of cleanup.reverse()) await Promise.resolve(stop()).catch(() => {});
  await h.close();
}

function passed(name) {
  if (real) console.log(`Codex PASS: ${name}`);
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

async function missingCodexPath() {
  const bin = await h.folder("missing-codex-bin");
  // The temporary home hides user installs. If the machine also has a
  // system-wide Codex, reproduce an exec failure in an empty search path
  // so the offline test never calls the real program.
  if (["/opt/homebrew/bin/codex", "/usr/local/bin/codex"].some(existsSync)) {
    await writeFile(
      join(bin, "codex"),
      "#!/bin/sh\nPATH=/dev/null exec /bin/sh -c 'exec codex' tokamak-program\n",
      { mode: 0o755 },
    );
  }
  return bin;
}

async function replayExecutable() {
  const replay = join(workspace, "e2e/fake-agent/program.mjs");
  await writeFile(
    join(path, "codex"),
    `#!/bin/sh
status=$(cat "$CODEX_HOME/auth.json")
case "$1" in
  --version)
    case "$status" in
      old) echo 'codex-cli 0.169.0' ;;
      prerelease) echo 'codex-cli 0.171.0-alpha.1' ;;
      *) echo 'codex-cli 0.170.0' ;;
    esac
    ;;
  app-server)
    # Discovery runs from HOME with the direct launcher and from the plugin
    # root's parent with Runner. A turn has its own explicit working folder.
    if [ "$PWD" -ef "$HOME" ] || [ "$PWD/home" -ef "$HOME" ]; then
      if [ "$status" = "signed-out" ]; then tape=signed-out; else tape=info; fi
    else
      tape="\${PWD##*/}"
    fi
    if [ "$tape" = hello ]; then
      trap '' TERM
      ${shellQuote(bunPath())} ${shellQuote(replay)} --replay "codex/$tape"
      /bin/sleep 0.4
      printf flushed > session-flushed
    else
      exec ${shellQuote(bunPath())} ${shellQuote(replay)} --replay "codex/$tape"
    fi
    ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
}
