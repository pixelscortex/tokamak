// End to end for a turn whose app went away (see e2e/fake-agent): the real
// server, real windows and local parts, and the replay program. While a turn
// runs, the sender's local part sends a sign of life; after 45 seconds of
// silence the server ends the turn as interrupted ("Tokamak was closed"),
// keeps the reply so far and frees the thread. A slow agent in an open app is
// never interrupted, however long it is quiet.
//
// The 45 seconds are a constant of ai's server code, which a test cannot
// change on the real server, so this waits them out for real: twice in a row
// (a running turn, then the queue stranded behind it), with the lost-server
// case alongside. Allow about two minutes in the offline server suite.
import assert from "node:assert/strict";
import { isFailure } from "../../sdk/src/index.ts";
import { BEAT_MS, SILENCE_MS } from "../../../plugins/ai/src/shared/turn-timing.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentHarness } from "../../../e2e/fake-agent/harness.mjs";

const h = await agentHarness({ binary: process.argv[2], name: "ai-liveness" });
const { ai, chat } = h.api;
const AGENT = { id: "fake-agent", name: "Fake agent" };
const replyOf = (turn) => (messages) => messages.find((message) => message._id === turn.replyId);
/** Allow for the server's sweep and slower scheduling under CI load. */
const NOTICED_MS = SILENCE_MS + 30_000;

try {
  // The lost server waits out its own 45 seconds alongside.
  await Promise.all([lostServer(), crashedApp()]);
  console.log(
    "ai liveness: killed app interrupted after 45 s with its reply kept, waiting question ended, stranded queue settled, slow turn kept running, thread free again, agent stopped when the server stays out of reach",
  );
} finally {
  await h.close();
}

async function crashedApp() {
  const address = await h.serve("liveness");
  // Two apps on the person's computer: one crashes mid-turn, the other stays open.
  const crashing = await h.connect(address, { local: true });
  const open = await h.connect(address, { local: true });
  const watcher = await h.connect(address);

  /** A new thread with its first message sent from `client`, and its turn started there. */
  async function startTurn(client, label, model, more = {}) {
    const folder = await h.folder(label);
    const { threadId, messageId } = await client.mutation(chat.threads.start, {
      text: `Work on ${label}`,
      folder: { kind: "chosen", path: folder },
    });
    const running = client.local(ai.run.turn, {
      threadId,
      messageId,
      folder,
      agentId: AGENT.id,
      model,
      ...more,
    });
    void running.catch(() => {});
    const turns = h.watch(watcher, ai.turns.list, { threadId });
    const messages = h.watch(watcher, chat.messages.list, { threadId });
    return { folder, threadId, running, turns, messages };
  }

  // A running turn that has written part of its reply, a turn waiting on a
  // permission question with a message queued behind it, and a slow turn in the open app.
  const writing = await startTurn(crashing, "writing", "echo");
  const asking = await startTurn(crashing, "asking", "ask-once", { access: "ask" });
  const slow = await startTurn(open, "slow", "slow");
  const [written] = await writing.turns.until("running turn", (list) => list[0]?.state === "running");
  await writing.messages.until(
    "partial reply",
    (list) => replyOf(written)(list)?.parts[0]?.text === "Reading your message.",
  );
  const [waiting] = await asking.turns.until("waiting turn", (list) => list[0]?.state === "waiting");
  assert.equal(waiting.question.subject, "git push origin feat/csv-export");
  const queued = await crashing.mutation(ai.turns.enqueue, {
    threadId: asking.threadId,
    text: "Then push the tag",
    agent: AGENT,
    model: "echo",
    access: "full",
  });
  const [slowTurn] = await slow.turns.until("slow turn running", (list) => list[0]?.state === "running");

  // The first app dies with its turns on the go: nobody calls finish.
  await h.quit(crashing);
  const quitAt = Date.now();

  // Not before the silence limit: the last sign of life came at most one beat before the quit.
  await Bun.sleep(SILENCE_MS - BEAT_MS - 5_000);
  assert.equal((await watcher.query(ai.turns.list, { threadId: writing.threadId }))[0].state, "running");

  const [interrupted] = await writing.turns.until(
    "interrupted after the silence",
    (list) => list[0].state === "interrupted",
    NOTICED_MS,
  );
  const silence = Date.now() - quitAt;
  assert.ok(silence >= SILENCE_MS - BEAT_MS && silence <= NOTICED_MS, `interrupted after ${silence} ms`);
  assert.equal(interrupted.error, "Tokamak was closed");
  assert.ok(interrupted.finishedAt >= interrupted.startedAt);
  // The reply so far is kept, and marked as interrupted with its reason.
  const kept = replyOf(interrupted)(await watcher.query(chat.messages.list, { threadId: writing.threadId }));
  assert.equal(kept.status, "interrupted");
  assert.equal(kept.error, "Tokamak was closed");
  assert.equal(kept.parts[0].text, "Reading your message.");

  // The waiting turn ends the same way and its question is gone.
  const [ended] = await asking.turns.until(
    "waiting turn interrupted",
    (list) => list[0].state === "interrupted",
  );
  assert.equal("question" in ended, false);
  assert.deepEqual(await open.query(ai.turns.questions, {}), []);

  // The slow turn in the open app was quiet just as long, and still runs.
  const [still] = await slow.turns.until("slow turn", () => true);
  assert.equal(still.state, "running", "a slow but alive turn is never interrupted");
  assert.ok(Date.now() - slowTurn.startedAt > SILENCE_MS);

  // The thread is free: the open app begins a new turn in it at once.
  const next = await open.mutation(chat.messages.post, { threadId: writing.threadId, text: "Carry on" });
  const resumed = await open.local(ai.run.turn, {
    threadId: writing.threadId,
    messageId: next,
    folder: writing.folder,
    agentId: AGENT.id,
    model: "fail",
  });
  assert.ok(!isFailure(resumed), `a new turn begins: ${JSON.stringify(resumed)}`);
  assert.equal(resumed.state, "failed");

  // The message queued in the crashed app is left with nobody to start it.
  // Once its thread has been free for the same 45 seconds, it is settled too,
  // so the thread does not stay blocked behind it.
  const settled = await asking.turns.until(
    "stranded queue settled",
    (list) => list.find((turn) => turn._id === queued.turnId)?.state === "interrupted",
    NOTICED_MS,
  );
  assert.equal(settled.find((turn) => turn._id === queued.turnId).error, "Tokamak was closed");
  const delivered = (await watcher.query(chat.messages.list, { threadId: asking.threadId })).find(
    (message) => message._id === queued.messageId,
  );
  assert.notEqual(delivered.status, "queued", "the dashed message is no longer queued");
  assert.equal(await watcher.query(ai.turns.pending, { threadId: asking.threadId }), null);

  // The slow turn finishes normally when its agent is done.
  assert.equal((await watcher.query(ai.turns.list, { threadId: slow.threadId }))[0].state, "running");
  await h.gate(slow.folder, "go");
  assert.equal((await slow.running).state, "done");
}

/**
 * The other way round: the app stays open but cannot reach the server (it
 * crashed, the network went). After the same 45 seconds without a beat getting
 * through, the app stops its agent, so nothing keeps working into a turn the
 * server has given up on, even an agent that ignores Stop and its children.
 */
async function lostServer() {
  const address = await h.serve("lost");
  const desk = await h.connect(address, { local: true });
  const folder = await h.folder("lost");
  const { threadId, messageId } = await desk.mutation(chat.threads.start, {
    text: "Keep going",
    folder: { kind: "chosen", path: folder },
  });
  const running = desk.local(ai.run.turn, {
    threadId,
    messageId,
    folder,
    agentId: AGENT.id,
    model: "ignore-stop",
  });
  void running.catch(() => {});
  const turns = h.watch(desk, ai.turns.list, { threadId });
  await turns.until("running turn", (list) => list[0]?.state === "running");
  const pids = await within(async () =>
    JSON.parse(await readFile(join(folder, "process-tree.json"), "utf8")),
  );
  assert.equal(pids.length, 3);
  await h.halt(address);
  const cutOff = Date.now();
  await Bun.sleep(SILENCE_MS - BEAT_MS);
  assert.ok(pids.every(alive), "the agent runs on while the server may still come back");
  const deadline = cutOff + NOTICED_MS;
  while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(500);
  assert.deepEqual(
    pids.filter(alive),
    [],
    "the agent and its children are stopped once the server stays out of reach",
  );
}

/** Retries `read` until it stops throwing (a file the agent writes a moment later). */
async function within(read, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (Date.now() > until) throw error;
      await Bun.sleep(100);
    }
  }
}

/** Whether a process still runs (a zombie waiting for its parent counts as gone). */
function alive(pid) {
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  return stat !== "" && !stat.startsWith("Z");
}
