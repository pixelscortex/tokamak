import assert from "node:assert/strict";
import type { TokamakClient } from "@tokamak/sdk";
import { acpScenario, turnTokenScenario } from "./acp-driver";
import { api } from "./chat/backend/_generated/api";
export async function chatScenario(client: TokamakClient, scenario: string) {
  if (scenario === "chat-turn-token") return turnTokenScenario(client);
  if (scenario === "chat-acp") return acpScenario(client);
  const threadId = await client.action(api.threads.create, {});
  assert.equal((await client.query(api.threads.list, {}))[0]!.backend, undefined);
  await assert.rejects(
    client.action(api.chat.send, { threadId, text: "hello" }),
    /No agent configured: see agents.example.toml/,
  );
  await assert.rejects(
    client.mutation(api.send.start, { token: "fixture-turn-token", threadId, text: "hello" }),
    /No agent configured/,
  );
  assert.deepEqual(await client.query(api.messages.list, { threadId }), []);
  assert.equal(await client.query(api.runs.active, { threadId }), null);
  if (scenario === "chat-backend-missing") {
    assert.deepEqual(await client.action(api.backends.list, {}), []);
    for (const plugin of ["absent", "record"]) {
      await client.mutation(api.threads.setBackend, {
        threadId,
        backend: { kind: "plugin", plugin, backendId: "missing" },
      });
      await assert.rejects(client.action(api.chat.send, { threadId, text: "hello" }), /No agent configured/);
      assert.deepEqual(await client.query(api.messages.list, { threadId }), []);
    }
    return;
  }
  await client.mutation(api.threads.setBackend, {
    threadId,
    backend: { kind: "plugin", plugin: "fixture", backendId: "test" },
  });
  if (scenario === "chat-parts") {
    const testThread = threadId;
    const run = await client.mutation(api.send.start, {
      token: "fixture-turn-token",
      threadId: testThread,
      text: "Tools",
    });
    const update = (
      tool:
        | import("./chat/backend/parts").ToolPart
        | { callId: string; status: "done" | "error"; result?: {} },
    ) => client.mutation(api.send.update, { token: "fixture-turn-token", runId: run.runId, delta: "", tool });
    const tool = {
      type: "tool" as const,
      callId: "unique",
      plugin: "b",
      toolName: "fixture.create",
      args: {},
      status: "running" as const,
    };
    await assert.rejects(update({ ...tool, args: { title: "x".repeat(17_000) } }), /16 KB/);
    await update(tool);
    const runningTool = (await client.query(api.messages.list, { threadId: testThread }))[1]!.parts[0]!;
    assert.ok(runningTool.type === "tool" && runningTool.status === "running");
    await assert.rejects(update(tool), /Duplicate/);
    await assert.rejects(update({ ...tool, plugin: "other", status: "done" }), /immutable/);
    await update({ callId: tool.callId, status: "done", result: {} });
    await assert.rejects(update({ callId: tool.callId, status: "error" }), /settled/);
    await update({ ...tool, callId: "long-error" });
    await client.mutation(api.send.update, {
      token: "fixture-turn-token",
      runId: run.runId,
      delta: "",
      tool: {
        callId: "long-error",
        status: "error",
        error: "界".repeat(10_000),
      },
    });
    const bounded = (await client.query(api.messages.list, { threadId: testThread }))[1]!.parts[1]!;
    assert.ok(bounded.type === "tool" && Buffer.byteLength(bounded.error!) <= 2048);
    await update({ ...tool, callId: "cancel-me" });
    await client.mutation(api.runs.cancel, { runId: run.runId });
    const cancelled = (await client.query(api.messages.list, { threadId: testThread }))[1]!;
    assert.ok(cancelled.parts[2]!.type === "tool" && cancelled.parts[2]!.error === "cancelled");
    await client.mutation(api.threads.remove, { threadId: testThread });

    return;
  }
  const input = { threadId, text: "Say hello" };
  if (scenario === "chat-recovery") {
    const stale = await client.mutation(api.send.start, { ...input, token: "fixture-turn-token" });
    await client.mutation(api.send.update, {
      token: "fixture-turn-token",
      runId: stale.runId,
      delta: "",
      tool: {
        callId: "stale-tool",
        plugin: "b",
        toolName: "fixture.create",
        args: {},
        status: "running",
      },
    });
    const observe = (sweepId: string, tick: number) => client.mutation(api.runs.observe, { sweepId, tick });
    // Future timestamps model a backward clock jump; sends still refuse busy runs.
    await client.mutation(api.testing.age, { runId: stale.runId, offset: 3_600_000 });
    await assert.rejects(client.action(api.chat.send, input), /already has an active run/);
    await observe("first", 0);
    await observe("first", 0); // Retried ticks cannot advance the observation.
    await observe("first", 1);
    assert.equal((await client.query(api.runs.active, { threadId }))?._id, stale.runId);
    await observe("first", 2);
    const interrupted = (await client.query(api.messages.list, { threadId }))[1]!;
    assert.equal(interrupted.status, "error");
    assert.equal(interrupted.error, "Interrupted");
    assert.equal(interrupted.parts[0]!.type, "tool");
    assert.ok(interrupted.parts[0]!.type === "tool" && interrupted.parts[0]!.error === "Interrupted");
    assert.deepEqual(await client.query(api.runs.running, {}), []);

    const healthy = await client.mutation(api.send.start, { ...input, token: "fixture-turn-token" });
    for (let tick = 0; tick < 4; tick++) {
      await client.mutation(api.send.update, {
        token: "fixture-turn-token",
        runId: healthy.runId,
        delta: "",
      });
      await client.mutation(api.testing.age, { runId: healthy.runId, offset: -61_000 });
      await observe("healthy", tick);
      await observe("other", tick);
      assert.equal(
        (await client.query(api.runs.active, { threadId }))!.observations!.find(
          (item) => item.sweepId === "healthy",
        )!.unchanged,
        tick === 0 ? 1 : 0,
      );
    }
    await observe("other", 4);
    for (let tick = 0; tick < 3; tick++) await observe("healthy", tick);
    const replayed = (await client.query(api.runs.active, { threadId }))!;
    assert.equal(replayed._id, healthy.runId);
    assert.equal(replayed.observations!.find((item) => item.sweepId === "healthy")!.tick, 3);
    // A fifth sweeper evicts the smallest tick without disturbing retained streaks.
    await observe("oldest", 0);
    await observe("third", 5);
    await observe("fourth", 6);
    const bounded = (await client.query(api.runs.active, { threadId }))!.observations!;
    assert.equal(bounded.length, 4);
    assert.ok(!bounded.some((item) => item.sweepId === "oldest"));
    await client.mutation(api.runs.cancel, { runId: healthy.runId });
    await observe("healthy", 4);
    assert.equal((await client.query(api.messages.list, { threadId }))[3]!.status, "cancelled");

    const abandoned = await client.mutation(api.send.start, { ...input, token: "fixture-turn-token" });
    await client.mutation(api.testing.age, { runId: abandoned.runId, offset: -61_000 });
    await assert.rejects(client.action(api.chat.send, input), /already has an active run/);
    for (let tick = 0; tick < 2; tick++) {
      await observe("client-a", tick);
      await observe("client-b", tick);
      assert.equal((await client.query(api.runs.active, { threadId }))?._id, abandoned.runId);
    }
    const alternating = (await client.query(api.runs.active, { threadId }))!.observations!;
    assert.deepEqual(
      alternating.map((item) => item.unchanged),
      [2, 2],
    );
    await observe("client-a", 2);
    await observe("client-b", 2);
    assert.equal(await client.query(api.runs.active, { threadId }), null);
    return;
  }
  const second = await client.action(api.threads.create, { title: "Second" });
  await client.mutation(api.threads.rename, { threadId, title: "Renamed" });
  assert.equal(
    (await client.query(api.threads.list, {})).find((thread) => thread._id === threadId)!.title,
    "Renamed",
  );
  const run = await client.mutation(api.send.start, { ...input, token: "fixture-turn-token" });
  await client.mutation(api.send.update, {
    token: "fixture-turn-token",
    runId: run.runId,
    delta: "Hello",
    outcome: "done",
  });
  assert.equal((await client.query(api.messages.list, { threadId }))[1]!.parts[0]!.type, "text");
  await client.mutation(api.threads.remove, { threadId });
  assert.deepEqual(await client.query(api.messages.list, { threadId }), []);
  assert.equal(await client.query(api.testing.run, { runId: run.runId }), null);
  await client.mutation(api.threads.remove, { threadId: second });
  assert.deepEqual(await client.query(api.threads.list, {}), []);
}
