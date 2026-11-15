import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { TokamakClient } from "@tokamak/sdk";
import { api } from "./chat/backend/_generated/api";
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
    const threadId = await client.mutation(api.threads.create, {});
    let first = "";
    const stop = client.subscribe(api.messages.list, { threadId }, event => {
      if ("value" in event && !first) first = event.value.find(row => row.role === "assistant")?.parts.find(part => part.type === "text")?.text ?? "";
    });
    try {
      const result = await client.action(api.chat.send, { threadId, text: "Reply with a short greeting." });
      const messages = await client.query(api.messages.list, { threadId });
      assert.equal(result.status, "done", messages[1]?.error ?? "Unexpected run status");
      console.error(`OpenRouter first tokens: ${JSON.stringify(first.slice(0, 160))}`);
    } finally { stop(); }
    return;
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
      assert.deepEqual(request.tools.map((tool: { function: { name: string } }) => tool.function.name), ["b__fixture_create"]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (requests++ === 0) {
        res.end(`data: ${JSON.stringify({ id: "tool", object: "chat.completion.chunk", created: 1, model: "mock",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function",
            function: { name: "b__fixture_create", arguments: JSON.stringify({ title: scenario === "chat-tools-error" ? "fail" : "milk" }) } }] }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: "tool", object: "chat.completion.chunk", created: 1, model: "mock",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      } else {
        assert.ok(request.messages.some((message: { role: string; content: string }) => message.role === "tool" &&
          message.content.includes(scenario === "chat-tools-error" ? "fixture tool failed" : "Fixture created")));
        res.end(completionChunk("Added it.") + completionEnd());
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
    const threadId = await client.mutation(api.threads.create, {});
    const input = { threadId, text: "Say hello" };
    if (scenario === "chat-recovery") {
      const stale = await client.mutation(api.send.start, input);
      await client.mutation(api.testing.age, { runId: stale.runId });
      await client.mutation(api.runs.recover, {});
      const interrupted = (await client.query(api.messages.list, { threadId }))[1]!;
      assert.equal(interrupted.status, "error");
      assert.equal(interrupted.error, "Interrupted");
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
      assert.equal(messages[7]!.parts[0]!.text, "Recovered");
      assert.equal(await client.query(api.runs.active, { threadId }), null);
      // Exercise the real action heartbeat while the provider withholds headers.
      holdHeaders = true;
      const silent = client.action(api.chat.send, { threadId, text: "Quiet provider" });
      await until(async () => !!await client.query(api.runs.active, { threadId }));
      const quiet = (await client.query(api.runs.active, { threadId }))!;
      await client.mutation(api.testing.age, { runId: quiet._id });
      await until(async () => typeof (await client.query(api.runs.active, { threadId }))?.updatedAt === "number", 750);
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
          assert.deepEqual(response.parts.map(part => part.type), ["tool", "text"]);
          const tool = response.parts[0]!;
          assert.equal(tool.type, "tool");
          if (tool.type !== "tool") throw new Error("Expected tool");
          assert.equal(tool.plugin, "b");
          assert.equal(tool.toolName, "fixture.create");
          assert.equal(tool.status, scenario === "chat-tools-error" ? "error" : "done");
          if (scenario === "chat-tools-error") assert.match(tool.error!, /fixture tool failed/);
          assert.ok(toolStates.includes("running"), JSON.stringify(toolStates));
          await until(() => toolStates.includes(tool.status));
          assert.equal(response.parts.find(part => part.type === "text")!.text, "Added it.");
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
