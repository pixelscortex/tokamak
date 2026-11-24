import assert from "node:assert/strict";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editBundle, inspectHosts, reload, until } from "../../runner/tests/support/routing.mjs";
import { FORCE_STOP_MS } from "../../../plugins/ai/src/shared/turn-timing.ts";
import { alive, gitPids, stall } from "./code-snapshot-review-cases.mjs";

export async function separateProcesses({ h, runner, desk, code, project, start, refs, turnRef }) {
  const { chat } = h.api;
  const hosts = await inspectHosts(runner);
  const host = (id) => hosts().find((process) => process.id === id)?.pid;
  const originalAi = host("ai");
  const originalCode = host("code");
  assert.ok(
    originalAi && originalCode && originalAi !== originalCode,
    "snapshots warm a separate code process",
  );

  const roots = await Promise.all([project("first-thread"), project("second-thread")]);
  const running = await Promise.all(
    roots.map(async ({ folder }, i) => {
      await writeFile(join(folder, "agent.txt"), `Before thread ${i}\n`);
      const thread = await start(desk, folder);
      const done = thread.run(thread.messageId, "edit");
      await thread.edited();
      return { thread, done };
    }),
  );
  for (const i of [1, 0]) {
    const { thread, done } = running[i];
    const { folder, git } = roots[i];
    await h.gate(folder, "go");
    const { turnId, state, hookNotice } = await done;
    assert.equal(state, "done");
    assert.equal(hookNotice, undefined);
    const prefix = turnRef(thread.threadId, turnId);
    assert.equal(git("show", `${prefix}/before:agent.txt`), `Before thread ${i}`);
    assert.equal(git("rev-parse", `${prefix}/after^`), git("rev-parse", `${prefix}/before`));
  }

  const crash = await project("code-process-crash");
  const crashedTurn = await start(desk, crash.folder);
  const interrupted = crashedTurn.run(crashedTurn.messageId, "edit");
  await crashedTurn.edited();
  process.kill(originalCode, "SIGKILL");
  await until("code's process exited", () => !alive(originalCode));
  // The replacement process must find the before ref without any in-memory state.
  await desk.local(code.hooks.prune, {});
  await h.gate(crash.folder, "go");
  const done = await interrupted;
  assert.deepEqual(done, { turnId: done.turnId, state: "done" });
  const recovered = turnRef(crashedTurn.threadId, done.turnId);
  assert.deepEqual(refs(crash.git), [`${recovered}/after`, `${recovered}/before`]);
  assert.equal(crash.git("rev-parse", `${recovered}/after^`), crash.git("rev-parse", `${recovered}/before`));
  assert.equal(host("ai"), originalAi);

  const updated = await project("code-process-reload");
  const reloadedTurn = await start(desk, updated.folder);
  const duringReload = reloadedTurn.run(reloadedTurn.messageId, "edit");
  await reloadedTurn.edited();
  const oldCode = host("code");
  await editBundle(join(h.plugins, "code"), "/* replacement local artifact */");
  await reload(runner, join(h.scratch, "snapshots"), "code");
  await desk.local(code.hooks.prune, {});
  assert.ok(hosts().some(({ id, pid }) => id === "code" && pid !== oldCode));
  await h.gate(updated.folder, "go");
  const finished = await duringReload;
  assert.deepEqual(finished, { turnId: finished.turnId, state: "done" });
  const reloaded = turnRef(reloadedTurn.threadId, finished.turnId);
  assert.equal(
    updated.git("rev-parse", `${reloaded}/after^`),
    updated.git("rev-parse", `${reloaded}/before`),
  );
  const newTurn = await reloadedTurn.run(await reloadedTurn.post(), "edit");
  assert.deepEqual(newTurn, { turnId: newTurn.turnId, state: "done" });
  assert.deepEqual(
    hosts()
      .filter(({ id }) => id === "ai")
      .map(({ pid }) => pid),
    [originalAi],
    "a new turn reuses the only ai process after changing Code",
  );
  await desk.local(chat.threads.removeLocal, { threadId: reloadedTurn.threadId });
  assert.deepEqual(refs(updated.git), [], "the deletion hook routes to the replacement code process");
  console.log(
    "code snapshots: overlapping turns, separate provider PID, code crash, code reload and routed deletion",
  );
}

export async function stopIsolation({ h, desk, project, start, refs, turnRef }) {
  const { ai } = h.api;
  const { folder, git } = await project("force-stop");
  const agent = await start(desk, folder);
  const running = agent.run(agent.messageId, "ignore-stop");
  const [turn] = await agent.turns.until("agent turn started", (rows) => rows.length === 1);
  await h.waitFor(folder, "process-tree.json");
  const agentPids = await Bun.file(join(folder, "process-tree.json")).json();
  const args = { turnId: turn._id };
  await desk.local(ai.run.stop, args);
  const [stopping] = await agent.turns.until("agent stopping", (rows) => !!rows[0]?.stoppingAt);

  const blocked = await project("stop-before");
  await stall(blocked);
  await blocked.write("agent.txt", "Start a slow before snapshot.\n");
  const hook = await start(desk, blocked.folder);
  const pending = hook.run(hook.messageId, "edit");
  const pids = await gitPids(blocked);
  await Bun.sleep(Math.max(0, stopping.stoppingAt + FORCE_STOP_MS - Date.now()));
  assert.equal(await desk.local(ai.run.forceStop, args), null);
  assert.ok(agentPids.every((pid) => !alive(pid)));
  assert.ok(pids.every(alive), "agent Force stop leaves the running hook's Git group alone");
  assert.deepEqual(await running, { turnId: turn._id, state: "stopped" });
  const prefix = turnRef(agent.threadId, turn._id);
  assert.deepEqual(refs(git, prefix), [`${prefix}/after`, `${prefix}/before`]);

  const [before] = await hook.turns.until("before hook is running", (rows) => rows.length === 1);
  await desk.local(ai.run.stop, { turnId: before._id });
  assert.equal((await pending).state, "stopped");
  await until("Stop cancels the hook's Git group", () => pids.every((pid) => !alive(pid)));
  assert.deepEqual(refs(blocked.git), []);

  console.log("code snapshots: Force stop isolated agent programs; Stop cancelled before");
}

export async function stopDuringAfter({ h, desk, project, start, refs, turnRef }) {
  const { ai } = h.api;
  const final = await project("stop-after");
  const after = await start(desk, final.folder);
  const finishing = after.run(after.messageId, "edit");
  await after.edited();
  await stall(final, "while [ ! -f .git/release-filter ]; do sleep 0.05; done");
  await h.gate(final.folder, "go");
  const afterPids = await gitPids(final);
  const [last] = await after.turns.until("after hook is running", (rows) => rows.length === 1);
  for (let i = 0; i < 2; i++) {
    const result = await desk.local(ai.run.stop, { turnId: last._id });
    assert.equal(result.kind, "NotRunning", "Stop cannot change a turn whose agent has settled");
  }
  assert.ok(afterPids.every(alive), "Stop leaves the after hook's Git group alone");
  await final.write(".git/release-filter", "");
  assert.deepEqual(await finishing, { turnId: last._id, state: "done" });
  const saved = turnRef(after.threadId, last._id);
  assert.deepEqual(refs(final.git), [`${saved}/after`, `${saved}/before`]);
  console.log("code snapshots: repeated Stop left the after hook and turn outcome alone");
}

export async function unavailableProviders({ h, runner, desk, code, project, start, refs }) {
  const { chat } = h.api;
  const hosts = await inspectHosts(runner);
  const { folder, git, write } = await project("code-outage");
  const cached = await start(desk, folder);
  await stall({ folder, git, write });
  await write("agent.txt", "before the crash\n");
  await h.gate(folder, "go");
  const crashed = cached.run(cached.messageId, "edit");
  const pids = await gitPids({ folder });
  const owner = Number(Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pids[0])]).stdout.toString());
  const codeHost = hosts().find(({ id, pid }) => id === "code" && pid === owner);
  assert.ok(codeHost, "the cached hook's Git process belongs to the Code host being killed");
  process.kill(codeHost.pid, "SIGKILL");
  const afterCrash = await crashed;
  assert.deepEqual(afterCrash, {
    turnId: afterCrash.turnId,
    state: "done",
    hookNotice: "Couldn't save this turn's code",
  });
  assert.deepEqual(refs(git), []);
  await until("crashed Code's Git group exited", () => pids.every((pid) => !alive(pid)));

  const installed = join(h.plugins, "code");
  const original = await readFile(join(installed, "local.js"), "utf8");
  // Keep Code's declaration available while making the new build fail to start.
  await editBundle(
    installed,
    "",
    (code) => `throw new Error("Code cannot start");
${code}`,
  );
  await reload(runner, join(h.scratch, "snapshots"), "code");
  const cold = await project("first-code-lookup");
  const fresh = await start(desk, cold.folder);
  await h.gate(cold.folder, "go");
  const first = await fresh.run(fresh.messageId, "edit");
  assert.deepEqual(first, {
    turnId: first.turnId,
    state: "done",
    hookNotice: "Couldn't save this turn's code",
  });
  assert.deepEqual(refs(cold.git), []);

  const cleanup = await project("unreachable-deletion");
  const doomed = await start(desk, cleanup.folder);
  // Record a real pair for the existing prune retry, then take this build down again.
  await editBundle(installed, "/* working before deletion */", () => original);
  await reload(runner, join(h.scratch, "snapshots"), "code");
  await h.gate(cleanup.folder, "go");
  assert.equal((await doomed.run(doomed.messageId, "edit")).hookNotice, undefined);
  assert.equal(refs(cleanup.git).length, 2);
  await editBundle(
    installed,
    "",
    (code) => `throw new Error("Code cannot start during deletion");
${code}`,
  );
  await reload(runner, join(h.scratch, "snapshots"), "code");
  assert.deepEqual(await desk.local(chat.threads.removeLocal, { threadId: doomed.threadId }), {
    warning: "The thread was deleted, but some of its local data couldn't be removed.",
  });
  assert.equal(await desk.query(chat.threads.get, { threadId: doomed.threadId }), null);
  assert.equal(refs(cleanup.git).length, 2);
  await editBundle(installed, "/* recovered from deletion outage */", () => original);
  await reload(runner, join(h.scratch, "snapshots"), "code");
  await desk.local(code.hooks.prune, {});
  assert.deepEqual(refs(cleanup.git), []);
  console.log(
    "code snapshots: crashed cached hook, failed first lookup and deletion outage with prune retry",
  );
}

export async function cancelledCleanup({ h, desk, project, start, refs }) {
  const { chat } = h.api;
  const { folder, git, write } = await project("cancel-packed-deletion");
  const thread = await start(desk, folder);
  await h.gate(folder, "go");
  assert.equal((await thread.run(thread.messageId, "edit")).state, "done");
  git("pack-refs", "--all", "--prune");
  assert.equal(refs(git).length, 2);

  // For this fixture only, pause real Git at its prepared transaction hook
  // while it owns the packed refs lock. Production still disables user hooks.
  const shim = join(h.bin, "git");
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    shim,
    `#!/bin/sh
if [ "$PWD" = ${quote(folder)} ]; then
  case " $* " in
    *" update-ref --no-deref --stdin "*) exec /usr/bin/git -c core.hooksPath=.git/hooks update-ref --no-deref --stdin ;;
  esac
fi
exec /usr/bin/git "$@"
`,
  );
  await chmod(shim, 0o755);
  await write(
    ".git/hooks/reference-transaction",
    `#!/bin/sh
if [ "$1" = prepared ] && [ -f .git/packed-refs.lock ]; then
  : > .git/cleanup-locked
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [ -f .git/release-cleanup ] && break
    sleep 1
  done
fi
cat >/dev/null
`,
  );
  await chmod(join(folder, ".git/hooks/reference-transaction"), 0o755);
  const fileExists = (path) =>
    stat(join(folder, path)).then(
      () => true,
      () => false,
    );
  const controller = new AbortController();
  const removing = desk.local(
    chat.threads.removeLocal,
    { threadId: thread.threadId },
    { signal: controller.signal },
  );
  await until("Git holds the packed refs lock", () => fileExists(".git/cleanup-locked"));
  assert.ok(await fileExists(".git/packed-refs.lock"));
  controller.abort();
  await assert.rejects(removing, /cancelled/);
  await write(".git/release-cleanup", "");
  await until(
    "Git completes the deletion and unlocks its refs",
    async () => !(await fileExists(".git/packed-refs.lock")) && refs(git).length === 0,
  );
  assert.equal(await desk.query(chat.threads.get, { threadId: thread.threadId }), null);
  console.log("code snapshots: cancellation lets Git release its packed refs lock");
}
