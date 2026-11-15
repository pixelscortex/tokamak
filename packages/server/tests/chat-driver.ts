import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApi, type ActionContext, type TokamakClient } from "@tokamak/sdk";
import { discoverTools } from "./chat/backend/tools";
import { send as chatSend } from "./chat/backend/chat";
import { api } from "./chat/backend/_generated/api";
import { api as todo } from "./todo/backend/_generated/api";
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
      if (requests++ === 0) {
        res.end(completionChunk("Before.") + `data: ${JSON.stringify({ id: "tool", object: "chat.completion.chunk", created: 1, model: "mock",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function",
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
