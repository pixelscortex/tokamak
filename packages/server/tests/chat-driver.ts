import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApi, type ActionContext, type TokamakClient } from "@tokamak/sdk";
import { discoverTools } from "./chat/backend/tools";
import { send as chatSend } from "./chat/backend/chat";
import { api } from "./chat/backend/_generated/api";
import { api as todo } from "./todo/backend/_generated/api";
import { CHAT_MODELS, DEFAULT_MODEL, currentModel } from "./chat/models";
import { completionChunk, completionEnd } from "./completions";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await wait(20);
  }
  throw new Error("Chat condition timed out");
}

export async function chatScenario(client: TokamakClient, scenario: string, configure: (url: string) => Promise<void>) {
  if (scenario === "chat-acp") {
    assert.deepEqual(await client.action(api.agents.list, {}), [{ id: "fake", title: "fake" }, { id: "fresh", title: "fresh" }]);
    const threadId = await client.mutation(api.threads.create, {});
    const backend = { kind: "acp" as const, agent: "fake", cwd: "/tmp" };
    await client.mutation(api.threads.setBackend, { threadId, backend });
    const send = (text: string) => client.action(api.chat.send, { threadId, text });
    const messages = () => client.query(api.messages.list, { threadId });
    assert.equal((await send("chat:normal")).status, "done");
    const parts = (await messages())[1]!.parts;
    assert.deepEqual(parts.map(part => part.type), ["text", "tool", "plan", "text"]);
    assert.deepEqual(parts[0], { type: "text", text: "Before." });
    assert.deepEqual(parts[3], { type: "text", text: "[image]" });
    const tool = parts[1]!;
    assert.ok(tool.type === "tool");
    assert.equal(tool.plugin, "acp:fake");
    assert.equal(tool.status, "done");
    assert.equal(tool.summary, "Reading file");
    assert.equal(tool.model, "Result");
    assert.deepEqual(tool.result, { truncated: true });
    assert.deepEqual(parts[2], { type: "plan", entries: [{ content: "Read", status: "completed", priority: "high" }] });
    assert.equal((await client.query(api.threads.list, {}))[0]!.backend?.kind, "acp");
    const stored = (await client.query(api.threads.list, {}))[0]!.backend;
    assert.ok(stored?.kind === "acp" && stored.sessionId === "session");
    // The fake recognizes only exact prompts: a history prefix on a restored turn fails these checks.
    for (const reason of ["max_tokens", "max_turn_requests", "refusal", "cancelled", "permission", "crash"]) {
      assert.equal((await send(`chat:${reason}`)).status, reason === "refusal" || reason === "crash" ? "error" : reason === "cancelled" ? "cancelled" : "done");
      const last = (await messages()).at(-1)!;
      if (reason === "refusal") assert.equal(last.error, "Agent refused");
      if (["refusal", "cancelled", "crash"].includes(reason)) {
        const tool = last.parts.find(part => part.type === "tool");
        assert.deepEqual(tool && { status: tool.status, error: tool.error }, { status: "error", error: reason === "cancelled" ? "cancelled" : last.error });
      }
      if (reason.startsWith("max_") || reason === "permission")
        assert.match(last.parts.filter(part => part.type === "text").map(part => part.text).join(""), reason === "permission" ? /permission request cancelled/ : /limit/);
    }
    const pending = send("chat:cancel");
    await until(async () => (await messages()).at(-1)?.parts.some(part => part.type === "tool" && part.status === "running") ?? false);
    const run = await client.query(api.runs.active, { threadId });
    assert.equal(run!.model, "acp:fake");
    await client.mutation(api.runs.cancel, { runId: run!._id });
    assert.equal((await pending).status, "cancelled");
    const cancelledTool = (await messages()).at(-1)!.parts.find(part => part.type === "tool");
    assert.ok(cancelledTool?.type === "tool" && cancelledTool.error === "cancelled");
    await client.mutation(api.threads.setBackend, { threadId, backend });
    assert.deepEqual((await client.query(api.threads.list, {}))[0]!.backend, stored);
    await client.mutation(api.threads.setBackend, { threadId, backend: { ...backend, cwd: "/" } });
    assert.deepEqual((await client.query(api.threads.list, {}))[0]!.backend, { ...backend, cwd: "/" });
    await client.mutation(api.threads.setBackend, { threadId, backend: { ...backend, agent: "other" } });
    assert.equal((await send("hello")).status, "error");
    await client.mutation(api.threads.setBackend, { threadId, backend: { ...backend, cwd: "/var" } });
    assert.equal((await send("auth")).status, "error");
    assert.equal((await messages()).at(-1)!.error, "Sign in to `fake` in a terminal");
    const fresh = await client.mutation(api.threads.create, {});
    const seeded = await client.mutation(api.send.start, { threadId: fresh, text: "old" + "界".repeat(12000) });
    await client.mutation(api.send.update, { runId: seeded.runId, delta: "previous answer", outcome: "done" });
    await client.mutation(api.threads.setBackend, { threadId: fresh, backend: { ...backend, agent: "fresh" } });
    assert.equal((await client.action(api.chat.send, { threadId: fresh, text: "new question" })).status, "done");
    const echoed = (await client.query(api.messages.list, { threadId: fresh })).at(-1)!.parts[0]!;
    assert.ok(echoed.type === "text");
    assert.match(echoed.text, /Previous conversation:/);
    assert.match(echoed.text, /assistant: previous answer/);
    assert.match(echoed.text, /user: new question$/);
    assert.ok(Buffer.byteLength(echoed.text) <= 32768 + 100);
    assert.ok(!echoed.text.includes("user: old"));
    const model = CHAT_MODELS[1];
    await client.mutation(api.threads.setBackend, { threadId: fresh, backend: { kind: "model", model } });
    const selected = (await client.query(api.threads.list, {})).find(thread => thread._id === fresh)!;
    assert.deepEqual([selected.model, currentModel({ ...selected, model: DEFAULT_MODEL })], [model, model]);
    return;
  }
  if (scenario === "chat-real") {
    const failures: string[] = [];
    for (const model of ["liquid/lfm-3-1.7b:free"]) {
      const threadId = await client.mutation(api.threads.create, {});
      await client.mutation(api.threads.setModel, { threadId, model });
      const result = await client.action(api.chat.send, { threadId, text: "Add a todo to buy milk tomorrow" });
      const messages = await client.query(api.messages.list, { threadId });
      const part = messages[1]?.parts.find(part => part.type === "tool" && part.plugin === "todo" && part.status === "done");
      if (result.status === "done" && part?.type === "tool") {
        const row = await client.query(todo.todo.get, { id: (part.result as { id: import("@tokamak/sdk").Id<"todos"> }).id });
        assert.ok(row);
        assert.match(row.title, /milk/i);
        console.error(`OpenRouter tool smoke passed: ${model}; tool part done; todo exists: ${JSON.stringify(row.title)}`);
        return;
      }
      const reason = messages[1]?.error ?? "no completed Todo tool call";
      failures.push(`${model}: ${reason}`);
      console.error(`OpenRouter tool smoke failed: ${model}: ${reason}`);
    }
    assert.fail(failures.join("\n"));
  }
  let holdHeaders = false;
  let releaseHeaders = false;
  let disconnected = false;
  let requested = false;
  let history: unknown;
  const toolStates: string[] = [];
  let requests = 0;
  let toolOnly = false;
  const growing: string[] = [];
  const mock = createServer(async (req, res) => {
    requested = true;
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization?.startsWith("Bearer "), true);
    let body = "";
    for await (const chunk of req) body += chunk;
    history = JSON.parse(body).messages;
    if (scenario === "chat-recovery") {
      if (holdHeaders) await until(() => releaseHeaders, 750);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(completionChunk("Recovered") + completionEnd());
      return;
    }
    if (scenario === "chat-tools" || scenario === "chat-tools-error") {
      const request = JSON.parse(body);
      assert.deepEqual(request.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(), ["todo__todos_create", "b__fixture_create"].sort());
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (requests++ === 0 || toolOnly) {
        res.end((toolOnly ? "" : completionChunk("Before.")) + `data: ${JSON.stringify({ id: "tool", object: "chat.completion.chunk", created: 1, model: "mock",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolOnly ? `call-${requests}` : "call-1", type: "function",
            function: { name: "b__fixture_create", arguments: JSON.stringify({ title: scenario === "chat-tools-error" ? "fail" : "milk" }) } }] }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: "tool", object: "chat.completion.chunk", created: 1, model: "mock",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      } else {
        assert.ok(request.messages.some((message: { role: string; content: string }) => message.role === "tool" &&
          message.content.includes(scenario === "chat-tools-error" ? "fixture tool failed" : "Fixture created")), JSON.stringify(request.messages));
        res.end(completionChunk("After.") + completionEnd());
      }
      return;
    }
    if (scenario === "chat-error") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Model is temporarily unavailable", type: "server_error" } }));
      return;
    }
    res.on("close", () => { disconnected = true; });
    res.writeHead(200, { "content-type": "text/event-stream" });
    let sent = "";
    for (const text of ["Hello", " there", " friend"]) {
      if (res.destroyed) return;
      res.write(completionChunk(text));
      if (scenario === "chat-cancel" || scenario === "chat-crud") return;
      sent += text;
      await until(() => growing.includes(sent));
    }
    res.end(completionEnd());
  });
  mock.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => mock.once("listening", resolve));
  const address = mock.address();
  assert.ok(address && typeof address !== "string");
  await configure(`http://127.0.0.1:${address.port}/v1`);

  try {
    if (scenario === "chat-tools") {
      // Hold execute until the action heartbeats: the stream consumer must keep
      // polling while a provider mutation is pending, rather than await execute.
      let executing = false;
      let releaseTool!: () => void;
      const heartbeat = new Promise<void>(resolve => { releaseTool = resolve; });
      const result = await chatSend.invoke({ threadId: "threads:heartbeat", text: "Say hello" }, {
        async op(operation, payload): Promise<import("@tokamak/sdk").JsonValue> {
          const input = payload as { name?: string; args?: { delta?: string; tool?: unknown; outcome?: string } };
          if (operation === "plugin.providers") return ["b", "todo"];
          if (operation === "action.env") return input.name === "OPENROUTER_API_KEY" ? "fixture" : `http://127.0.0.1:${address.port}/v1`;
          if (input.name === "chat/send:start") return { runId: "run", messageId: "message", history: [{ role: "user", content: "Say hello" }], model: "mock" };
          if (input.name === "chat/send:running") return true;
          if (input.name === "chat/send:update") {
            if (executing && !input.args?.delta && !input.args?.tool) releaseTool();
            return input.args?.outcome ?? "running";
          }
          if (input.name?.endsWith("/tools:describe")) return [{
            name: input.name.startsWith("todo/") ? "todos.create" : "fixture.create",
            description: "Create", parameters: { type: "object" },
          }];
          if (input.name === "b/tools:invoke") {
            executing = true;
            await heartbeat;
            return { result: {}, summary: "Created", model: "Fixture created" };
          }
          throw new Error(`Unexpected heartbeat test call: ${input.name}`);
        },
      });
      assert.ok(result && typeof result === "object" && !Array.isArray(result));
      assert.equal(result.status, "done");
      assert.ok(executing);
      requests = 0;
      let invocations = 0;
      let ack = "cancelled";
      const { tools } = await discoverTools({
        providers: async () => [createApi("b")],
        runQuery: async () => [{ name: "fixture.create", description: "Create", parameters: { type: "object" } }],
        runMutation: async () => { invocations++; return { result: {}, summary: "Created" }; },
      } as unknown as ActionContext, "thread", async () => true, async () => ack);
      const invoke = tools.b__fixture_create!.execute as unknown as (input: unknown, options: { toolCallId: string; messages: [] }) => Promise<unknown>;
      const execute = (callId: string, title: string) => invoke({ title }, { toolCallId: callId, messages: [] });
      await assert.rejects(execute("cancelled", "milk"), /cancelled/);
      await assert.rejects(execute("large", "x".repeat(1_100_000)), /16 KB/);
      assert.equal(invocations, 0);
      ack = "running";
      await execute("once", "milk");
      await assert.rejects(async () => execute("once", "milk"), /Duplicate/);
      assert.equal(invocations, 1);

      const testThread = await client.mutation(api.threads.create, {});
      const run = await client.mutation(api.send.start, { threadId: testThread, text: "Tools" });
      const update = (tool: import("./chat/backend/parts").ToolPart | { callId: string; status: "done" | "error"; result?: {} }) =>
        client.mutation(api.send.update, { runId: run.runId, delta: "", tool });
      const tool = { type: "tool" as const, callId: "unique", plugin: "b", toolName: "fixture.create", args: {}, status: "running" as const };
      await assert.rejects(update({ ...tool, args: { title: "x".repeat(17_000) } }), /16 KB/);
      await update(tool);
      await assert.rejects(update(tool), /Duplicate/);
      await assert.rejects(update({ ...tool, plugin: "other", status: "done" }), /immutable/);
      await update({ callId: tool.callId, status: "done", result: {} });
      await assert.rejects(update({ callId: tool.callId, status: "error" }), /settled/);
      await update({ ...tool, callId: "long-error" });
      await client.mutation(api.send.update, { runId: run.runId, delta: "", tool: {
        callId: "long-error", status: "error", error: "界".repeat(10_000),
      } });
      const bounded = (await client.query(api.messages.list, { threadId: testThread }))[1]!.parts[1]!;
      assert.ok(bounded.type === "tool" && Buffer.byteLength(bounded.error!) <= 2048);
      await update({ ...tool, callId: "cancel-me" });
      await client.mutation(api.runs.cancel, { runId: run.runId });
      const cancelled = (await client.query(api.messages.list, { threadId: testThread }))[1]!;
      assert.ok(cancelled.parts[2]!.type === "tool" && cancelled.parts[2]!.error === "cancelled");
      await client.mutation(api.threads.remove, { threadId: testThread });

      // Five tool-only steps hit stopWhen without producing a final text step.
      toolOnly = true;
      requests = 0;
      const toolThread = await client.mutation(api.threads.create, {});
      const toolResult = await client.action(api.chat.send, { threadId: toolThread, text: "Tools only" });
      const toolReply = (await client.query(api.messages.list, { threadId: toolThread }))[1]!;
      assert.equal(toolResult.status, "done");
      assert.equal(toolReply.status, "complete");
      assert.equal(requests, 5);
      assert.equal(toolReply.parts.length, 5);
      assert.ok(toolReply.parts.every(part => part.type === "tool" && part.status === "done"));
      assert.equal(await client.query(api.runs.active, { threadId: toolThread }), null);
      await client.mutation(api.threads.remove, { threadId: toolThread });
      toolOnly = false;
      requests = 0;
    }
    const threadId = await client.mutation(api.threads.create, {});
    const input = { threadId, text: "Say hello" };
    if (scenario === "chat-recovery") {
      const stale = await client.mutation(api.send.start, input);
      await client.mutation(api.send.update, { runId: stale.runId, delta: "", tool: {
        callId: "stale-tool", plugin: "b", toolName: "fixture.create", args: {}, status: "running",
      } });
      await client.mutation(api.testing.age, { runId: stale.runId });
      await client.mutation(api.runs.recover, {});
      const interrupted = (await client.query(api.messages.list, { threadId }))[1]!;
      assert.equal(interrupted.status, "error");
      assert.equal(interrupted.error, "Interrupted");
      assert.equal(interrupted.parts[0]!.type, "tool");
      assert.ok(interrupted.parts[0]!.type === "tool" && interrupted.parts[0]!.error === "Interrupted");
      assert.deepEqual(await client.query(api.runs.running, {}), []);

      const healthy = await client.mutation(api.send.start, input);
      await client.mutation(api.testing.age, { runId: healthy.runId });
      await client.mutation(api.send.update, { runId: healthy.runId, delta: "" });
      await client.mutation(api.runs.recover, {});
      assert.equal((await client.query(api.runs.active, { threadId }))?._id, healthy.runId);
      await client.mutation(api.runs.cancel, { runId: healthy.runId });
      await client.mutation(api.runs.recover, {});
      assert.equal((await client.query(api.messages.list, { threadId }))[3]!.status, "cancelled");

      const abandoned = await client.mutation(api.send.start, input);
      await client.mutation(api.testing.age, { runId: abandoned.runId });
      assert.equal((await client.action(api.chat.send, { threadId, text: "Try again" })).status, "done");
      const messages = await client.query(api.messages.list, { threadId });
      assert.equal(messages[5]!.error, "Interrupted");
      assert.equal(messages[7]!.parts.find(part => part.type === "text")!.text, "Recovered");
      assert.equal(await client.query(api.runs.active, { threadId }), null);
      // Exercise the real action heartbeat while the provider withholds headers.
      holdHeaders = true;
      const silent = client.action(api.chat.send, { threadId, text: "Quiet provider" });
      await until(async () => !!await client.query(api.runs.active, { threadId }));
      const quiet = (await client.query(api.runs.active, { threadId }))!;
      await client.mutation(api.testing.age, { runId: quiet._id });
      await until(async () => Date.now() - ((await client.query(api.runs.active, { threadId }))?.updatedAt ?? 0) < 60_000, 750);
      await client.mutation(api.runs.recover, {});
      assert.equal((await client.query(api.runs.active, { threadId }))?._id, quiet._id);
      releaseHeaders = true;
      assert.equal((await silent).status, "done");
      console.error("Stale run recovered: Interrupted; same thread accepted a new reply.");
      return;
    }
    if (scenario === "chat-crud") {
      const second = await client.mutation(api.threads.create, { title: "Second" });
      await client.mutation(api.threads.rename, { threadId, title: "Renamed" });
      const threads = await client.query(api.threads.list, {});
      assert.equal(threads[0]!._id, threadId);
      assert.equal(threads[0]!.title, "Renamed");
      const pending = client.action(api.chat.send, input);
      await until(async () => !!await client.query(api.runs.active, { threadId }));
      await client.mutation(api.threads.remove, { threadId });
      assert.equal((await pending).status, "cancelled");
      assert.deepEqual(await client.query(api.messages.list, { threadId }), []);
      assert.equal(await client.query(api.runs.active, { threadId }), null);
      assert.deepEqual((await client.query(api.threads.list, {})).map(row => row._id), [second]);
      return;
    }
    let subscriptionError: unknown;
    const stop = client.subscribe(api.messages.list, { threadId }, event => {
      if ("error" in event) { subscriptionError = event.error; return; }
      const message = event.value.find(row => row.role === "assistant");
      if (message) for (const part of message.parts) if (part.type === "tool") toolStates.push(part.status);
      if (message) growing.push(message.parts.map(part => part.type === "text" ? part.text : "").join(""));
    });
    try {
      const pending = client.action(api.chat.send, input);
      if (scenario === "chat-cancel") {
        await until(() => growing.includes("Hello"));
        const run = await client.query(api.runs.active, { threadId });
        assert.ok(run);
        await assert.rejects(client.action(api.chat.send, input), /already has an active run/);
        await client.mutation(api.runs.cancel, { runId: run._id });
        assert.equal((await pending).status, "cancelled");
        await until(() => disconnected);
      } else {
        const result = await pending;
        assert.equal(result.status, ["chat-error", "chat-grant"].includes(scenario) ? "error" : "done");
        const messages = await client.query(api.messages.list, { threadId });
        assert.deepEqual(messages.map(row => row.role), ["user", "assistant"]);
        const response = messages[1]!;
        if (scenario === "chat-error" || scenario === "chat-grant") {
          assert.equal(response.status, "error");
          assert.match(response.error!, scenario === "chat-grant" ? /permission denied: requires env:OPENROUTER_API_KEY/ : /temporarily unavailable|503/);
        } else if (scenario.startsWith("chat-tools")) {
          assert.equal(response.status, "complete");
          assert.deepEqual(response.parts.map(part => part.type), ["text", "tool", "text"]);
          const tool = response.parts[1]!;
          assert.equal(tool.type, "tool");
          if (tool.type !== "tool") throw new Error("Expected tool");
          assert.equal(tool.plugin, "b");
          assert.equal(tool.toolName, "fixture.create");
          assert.equal(tool.status, scenario === "chat-tools-error" ? "error" : "done");
          if (scenario === "chat-tools-error") assert.match(tool.error!, /fixture tool failed/);
          assert.ok(toolStates.includes("running"), JSON.stringify(toolStates));
          await until(() => toolStates.includes(tool.status));
          assert.equal(response.parts[0]!.type === "text" && response.parts[0]!.text, "Before.");
          assert.equal(response.parts[2]!.type === "text" && response.parts[2]!.text, "After.");
        } else {
          assert.equal(response.status, "complete");
          assert.equal(response.parts.find(part => part.type === "text")!.text, "Hello there friend");
          assert.ok(growing.includes("Hello"), JSON.stringify(growing));
          assert.ok(growing.includes("Hello there"), JSON.stringify(growing));
          assert.deepEqual(history, [{ role: "user", content: "Say hello" }]);
          // A second send supplies persisted history, and preserves ordering.
          await client.action(api.chat.send, { threadId, text: "Again" });
          assert.deepEqual(history, [
            { role: "user", content: "Say hello" }, { role: "assistant", content: "Hello there friend" },
            { role: "user", content: "Again" },
          ]);
        }
      }
      const messages = await client.query(api.messages.list, { threadId });
      assert.equal(messages[1]!.status, scenario === "chat-cancel" ? "cancelled" : ["chat-error", "chat-grant"].includes(scenario) ? "error" : "complete");
      assert.equal(await client.query(api.runs.active, { threadId }), null);
      assert.equal((await client.query(api.threads.list, {}))[0]!.title, "Say hello");
      assert.equal(subscriptionError, undefined);
      assert.equal(requested, scenario !== "chat-grant");
    } finally { stop(); }
  } finally {
    mock.closeAllConnections();
    await new Promise<void>(resolve => mock.close(() => resolve()));
  }
}
