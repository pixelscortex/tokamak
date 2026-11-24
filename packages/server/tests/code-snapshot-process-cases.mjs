import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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
  // Restart code before after, to exercise rejection of a receipt from a dead process.
  await desk.local(code.hooks.prune, {});
  await h.gate(crash.folder, "go");
  const done = await interrupted;
  assert.deepEqual(done, {
    turnId: done.turnId,
    state: "done",
    hookNotice: "Couldn't save this turn's code",
  });
  assert.deepEqual(refs(crash.git), [`${turnRef(crashedTurn.threadId, done.turnId)}/before`]);
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
  assert.equal((await duringReload).state, "done");
  const newTurn = await reloadedTurn.run(await reloadedTurn.post(), "edit");
  assert.deepEqual(newTurn, { turnId: newTurn.turnId, state: "done" });
  assert.equal(host("ai"), originalAi, "a new turn reuses ai after changing only code");
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

  const final = await project("stop-after");
  const after = await start(desk, final.folder);
  const finishing = after.run(after.messageId, "edit");
  await after.edited();
  await stall(final);
  await h.gate(final.folder, "go");
  const afterPids = await gitPids(final);
  const [last] = await after.turns.until("after hook is running", (rows) => rows.length === 1);
  await desk.local(ai.run.stop, { turnId: last._id });
  assert.deepEqual(await finishing, {
    turnId: last._id,
    state: "stopped",
    hookNotice: "Couldn't save this turn's code",
  });
  await until("Stop also cancels the after hook", () => afterPids.every((pid) => !alive(pid)));
  console.log("code snapshots: Force stop isolated agent programs; Stop cancelled before and after hooks");
}
