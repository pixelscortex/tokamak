import assert from "node:assert/strict";
import {
  createApi,
  functionName,
  type ActionContext,
  type FunctionReference,
  type TokamakClient,
} from "@tokamak/sdk";
import { acpSend } from "./acp/backend/acp";
import { api as acp } from "./acp/backend/_generated/api";
import { api } from "./chat/backend/_generated/api";
import { CHAT_MODELS, DEFAULT_MODEL, currentModel } from "./chat/models";
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await wait(20);
  }
  throw new Error("ACP condition timed out");
}
export async function acpScenario(client: TokamakClient) {
  assert.deepEqual(await client.action(acp.agents.list, {}), [
    { id: "fake", title: "fake" },
    { id: "fresh", title: "fresh" },
  ]);
  await client.action(acp.agents.checkFolder, { path: "/tmp" });
  for (const path of ["relative", "/tmp/tokamak-missing-folder/child", "/dev/null"]) {
    await assert.rejects(client.action(acp.agents.checkFolder, { path }), /ACP cwd/);
  }
  assert.deepEqual(await client.action(api.backends.list, {}), [
    { plugin: "acp", id: "fake", title: "fake", folder: true },
    { plugin: "acp", id: "fresh", title: "fresh", folder: true },
  ]);
  assert.deepEqual(
    await client.action(api.backends.configure, {
      plugin: "acp",
      backendId: "fake",
      settings: { cwd: "/tmp" },
    }),
    { cwd: "/tmp" },
  );
  const threadId = await client.mutation(api.threads.create, {});
  const backend = { kind: "plugin" as const, plugin: "acp", backendId: "fake", settings: { cwd: "/tmp" } };
  await client.mutation(api.threads.setBackend, { threadId, backend });
  const send = (text: string) => client.action(api.chat.send, { threadId, text });
  const messages = () => client.query(api.messages.list, { threadId });
  assert.equal((await send("chat:normal")).status, "done");
  const parts = (await messages())[1]!.parts;
  assert.deepEqual(
    parts.map((part) => part.type),
    ["text", "tool", "plan", "text"],
  );
  assert.deepEqual(parts[0], { type: "text", text: "Before." });
  assert.deepEqual(parts[3], { type: "text", text: "[image]" });
  const tool = parts[1]!;
  assert.ok(tool.type === "tool");
  assert.equal(tool.plugin, "acp:fake");
  assert.equal(tool.status, "done");
  assert.equal(tool.summary, "Reading file");
  assert.equal(tool.model, "Result");
  assert.deepEqual(tool.result, { truncated: true });
  assert.deepEqual(parts[2], {
    type: "plan",
    entries: [{ content: "Read", status: "completed", priority: "high" }],
  });
  assert.equal((await client.query(api.threads.list, {}))[0]!.backend?.kind, "plugin");
  const stored = (await client.query(api.threads.list, {}))[0]!.backend;
  assert.ok(stored?.kind === "plugin" && (stored.state as { sessionId: string }).sessionId === "session");
  // The fake recognizes only exact prompts: a history prefix on a restored turn fails these checks.
  for (const reason of ["max_tokens", "max_turn_requests", "refusal", "cancelled", "crash"]) {
    assert.equal(
      (await send(`chat:${reason}`)).status,
      reason === "refusal" || reason === "crash" ? "error" : reason === "cancelled" ? "cancelled" : "done",
    );
    const last = (await messages()).at(-1)!;
    if (reason === "refusal") assert.equal(last.error, "Agent refused");
    if (["refusal", "cancelled", "crash"].includes(reason)) {
      const tool = last.parts.find((part) => part.type === "tool");
      assert.deepEqual(tool && { status: tool.status, error: tool.error }, {
        status: "error",
        error: reason === "cancelled" ? "cancelled" : last.error,
      });
    }
    if (reason.startsWith("max_"))
      assert.match(
        last.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        /limit/,
      );
  }
  for (const mode of ["allow", "timeout", "cancel", "recovery"]) {
    const pendingPermission = send("chat:permission");
    await until(
      async () =>
        (await messages())
          .at(-1)
          ?.parts.some((part) => part.type === "permission" && part.status === "pending") ?? false,
    );
    const message = (await messages()).at(-1)!;
    const part = message.parts.find((part) => part.type === "permission")!;
    assert.ok(part.type === "permission");
    assert.equal(part.status, "pending");
    assert.equal(
      message.parts[message.parts.indexOf(part) - 1]!.type,
      "text",
      "text flushed before permission",
    );
    const run = (await client.query(api.runs.active, { threadId }))!;
    assert.equal(
      (await client.query(api.runs.running, {})).find((item) => item.runId === run._id)!.waiting,
      true,
    );
    const args = { messageId: message._id, requestId: part.requestId, optionId: "yes" };
    if (mode === "allow") {
      await assert.rejects(
        client.mutation(api.permissions.answer, { ...args, optionId: "invalid" }),
        /Unknown permission option/,
      );
      const answers = await Promise.allSettled([
        client.mutation(api.permissions.answer, args),
        client.mutation(api.permissions.answer, args),
      ]);
      assert.deepEqual(
        answers.map((answer) => answer.status),
        ["fulfilled", "rejected"],
      );
    } else if (mode === "cancel") {
      await client.mutation(api.runs.cancel, { runId: run._id });
    } else if (mode === "recovery") {
      // Simulate the final recovery transaction after an abandoned observation.
      await client.mutation(api.testing.abandon, { runId: run._id });
      await client.mutation(api.runs.observe, { sweepId: "abandoned", tick: 2 });
    } else {
      await until(
        async () => ((await client.query(api.runs.active, { threadId }))?.updatedAt ?? 0) > run.updatedAt!,
      );
    }
    const result = await pendingPermission;
    assert.equal(result.status, mode === "cancel" || mode === "recovery" ? "cancelled" : "done");
    const settled = (await messages()).at(-1)!;
    const permission = settled.parts.find((part) => part.type === "permission")!;
    assert.ok(permission.type === "permission");
    assert.equal(
      permission.status,
      mode === "allow" ? "answered" : mode === "cancel" ? "cancelled" : "expired",
    );
    if (mode === "allow") {
      assert.equal(permission.optionId, "yes");
      assert.match(JSON.stringify(settled.parts), /selected/);
    }
    if (mode === "timeout") assert.match(JSON.stringify(settled.parts), /cancelled/);
    if (mode === "recovery") assert.equal(settled.error, "Interrupted");
    assert.equal(
      (await client.query(api.runs.running, {})).some((item) => item.runId === run._id),
      false,
    );
    await assert.rejects(client.mutation(api.permissions.answer, args));
  }
  for (const mode of ["permission-finish", "permission-crash"]) {
    const result = await send(`chat:${mode}`);
    assert.equal(result.status, mode === "permission-finish" ? "done" : "error");
    const message = (await messages()).at(-1)!;
    assert.equal(message.parts.find((part) => part.type === "permission")?.status, "expired");
    assert.equal((await client.query(api.testing.run, { runId: result.runId }))!.waiting, false);
    await assert.rejects(
      client.mutation(api.permissions.answer, {
        messageId: message._id,
        requestId: message.parts.find((part) => part.type === "permission")!.requestId,
        optionId: "yes",
      }),
    );
  }
  const concurrent = send("chat:permissions");
  await until(
    async () =>
      (await messages())
        .at(-1)!
        .parts.filter((part) => part.type === "permission" && part.status === "pending").length === 2,
  );
  const concurrentMessage = (await messages()).at(-1)!;
  const requests = concurrentMessage.parts.filter((part) => part.type === "permission");
  await client.mutation(api.permissions.answer, {
    messageId: concurrentMessage._id,
    requestId: requests[0]!.requestId,
    optionId: "yes",
  });
  await until(async () =>
    (await messages()).at(-1)!.parts.some((part) => part.type === "permission" && part.status === "answered"),
  );
  assert.equal(
    (await client.query(api.runs.running, {})).find((run) => run.threadId === threadId)!.waiting,
    true,
  );
  await client.mutation(api.permissions.answer, {
    messageId: concurrentMessage._id,
    requestId: requests[1]!.requestId,
    optionId: "yes",
  });
  assert.equal((await concurrent).status, "done");

  // Exercise both sides of the claim/cancel boundary with real transactions.
  for (const cancelBeforeClaim of [true, false]) {
    const started = await client.mutation(api.send.start, {
      token: "fixture-turn-token",
      threadId,
      text: "race",
    });
    const delivered: (string | null)[] = [];
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = {
      use: (refs: unknown) => {
        const bind = (ref: unknown): unknown =>
          new Proxy(() => {}, {
            get: (_, key) => bind((ref as Record<string | symbol, unknown>)[key]),
            apply: (_, _this, [args]) => {
              const name = (ref as { [functionName]: string })[functionName];
              return /:(running|state)$/.test(name)
                ? context.runQuery(ref as FunctionReference<"query", unknown, unknown>, args)
                : context.runMutation(ref as FunctionReference<"mutation", unknown, unknown>, args);
            },
          });
        return bind(refs);
      },
      runQuery: client.query.bind(client),
      runMutation: async <A, R>(ref: FunctionReference<"mutation", A, R>, args: A) => {
        if (ref[functionName] === api.permissions.claim[functionName] && cancelBeforeClaim)
          await client.mutation(api.runs.cancel, { runId: started.runId });
        const result = await client.mutation(ref, args);
        if (ref[functionName] === api.permissions.claim[functionName] && !cancelBeforeClaim)
          await client.mutation(api.runs.cancel, { runId: started.runId });
        return result;
      },
      acp: {
        open: async () => ({ sessionId: "session", restored: true }),
        prompt: async function* () {
          yield {
            type: "permission",
            requestId: "race",
            toolCall: {},
            options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
          };
          await stopped;
          yield { type: "done", stopReason: "cancelled" };
        },
        respond: async ({ optionId }: { optionId: string | null }) => {
          delivered.push(optionId);
          release();
        },
        cancel: async () => {
          release();
        },
      },
    } as unknown as ActionContext;
    const action = acpSend(
      context,
      { threadId, text: "race" },
      { ...started, token: "fixture-turn-token" },
      {
        agent: backend.backendId,
        cwd: backend.settings.cwd,
      },
    );
    await until(async () => (await messages()).at(-1)!.parts.some((part) => part.type === "permission"));
    await client.mutation(api.permissions.answer, {
      messageId: started.messageId,
      requestId: "race",
      optionId: "yes",
    });
    await action;
    const permission = (await messages()).at(-1)!.parts.find((part) => part.type === "permission")!;
    assert.equal(permission.status, cancelBeforeClaim ? "cancelled" : "answered");
    assert.deepEqual(delivered, [cancelBeforeClaim ? null : "yes"]);
    assert.equal(
      (await client.query(api.runs.running, {})).some((run) => run.runId === started.runId),
      false,
    );
  }
  const pending = send("chat:cancel");
  await until(
    async () =>
      (await messages()).at(-1)?.parts.some((part) => part.type === "tool" && part.status === "running") ??
      false,
  );
  const run = await client.query(api.runs.active, { threadId });
  assert.equal(run!.model, "acp:fake");
  await client.mutation(api.runs.cancel, { runId: run!._id });
  assert.equal((await pending).status, "cancelled");
  const cancelledTool = (await messages()).at(-1)!.parts.find((part) => part.type === "tool");
  assert.ok(cancelledTool?.type === "tool" && cancelledTool.error === "cancelled");
  await client.mutation(api.threads.setBackend, { threadId, backend });
  assert.deepEqual((await client.query(api.threads.list, {}))[0]!.backend, stored);
  await client.mutation(api.threads.setBackend, {
    threadId,
    backend: { ...backend, settings: { cwd: "/" } },
  });
  assert.deepEqual((await client.query(api.threads.list, {}))[0]!.backend, {
    ...backend,
    settings: { cwd: "/" },
  });
  await client.mutation(api.threads.setBackend, { threadId, backend: { ...backend, backendId: "other" } });
  assert.equal((await send("hello")).status, "error");
  await client.mutation(api.threads.setBackend, {
    threadId,
    backend: { ...backend, settings: { cwd: "/var" } },
  });
  assert.equal((await send("auth")).status, "error");
  assert.equal((await messages()).at(-1)!.error, "Sign in to `fake` in a terminal");
  const fresh = await client.mutation(api.threads.create, {});
  const seeded = await client.mutation(api.send.start, {
    token: "fixture-turn-token",
    threadId: fresh,
    text: "old" + "界".repeat(12000),
  });
  await client.mutation(api.send.update, {
    token: "fixture-turn-token",
    runId: seeded.runId,
    delta: "previous answer",
    outcome: "done",
  });
  await client.mutation(api.threads.setBackend, {
    threadId: fresh,
    backend: { ...backend, backendId: "fresh" },
  });
  assert.equal(
    (await client.action(api.chat.send, { threadId: fresh, text: "new question" })).status,
    "done",
  );
  const echoed = (await client.query(api.messages.list, { threadId: fresh })).at(-1)!.parts[0]!;
  assert.ok(echoed.type === "text");
  assert.match(echoed.text, /Previous conversation:/);
  assert.match(echoed.text, /assistant: previous answer/);
  assert.match(echoed.text, /user: new question$/);
  assert.ok(Buffer.byteLength(echoed.text) <= 32768 + 100);
  assert.ok(!echoed.text.includes("user: old"));
  const model = CHAT_MODELS[1];
  await client.mutation(api.threads.setBackend, { threadId: fresh, backend: { kind: "model", model } });
  const selected = (await client.query(api.threads.list, {})).find((thread) => thread._id === fresh)!;
  assert.deepEqual([selected.model, currentModel({ ...selected, model: DEFAULT_MODEL })], [model, model]);
  return;
}

export async function turnTokenScenario(client: TokamakClient) {
  const attacker = createApi<{ ops: import("@tokamak/sdk").ApiFromModule<typeof import("./b/backend/ops")> }>(
    "b",
  );
  const threadId = await client.mutation(api.threads.create, {});
  await client.mutation(api.threads.setBackend, {
    threadId,
    backend: { kind: "plugin", plugin: "acp", backendId: "fake", settings: { cwd: "/tmp" } },
  });
  const pending = client.action(api.chat.send, { threadId, text: "chat:permission" });
  const messages = () => client.query(api.messages.list, { threadId });
  await until(
    async () => (await messages()).at(-1)?.parts.some((part) => part.type === "permission") ?? false,
  );
  const before = (await messages()).at(-1)!;
  const permission = before.parts.find((part) => part.type === "permission")!;
  const attack = await client.action(attacker.ops.attackTurn, { threadId, requestId: permission.requestId });
  assert.equal(attack.errors.length, 6);
  for (const error of attack.errors) assert.match(error, /token|Expected string/i);
  assert.ok(!("token" in attack.run));
  assert.ok(!JSON.stringify(await client.query(api.runs.running, {})).includes("token"));
  assert.deepEqual((await messages()).at(-1), before);
  assert.equal((await client.query(api.runs.active, { threadId }))!._id, attack.run._id);
  await client.mutation(api.permissions.answer, {
    messageId: before._id,
    requestId: permission.requestId,
    optionId: "yes",
  });
  const result = await pending;
  assert.equal(result.status, "done");
  const settled = (await messages()).at(-1)!;
  assert.equal(settled.parts.find((part) => part.type === "permission")!.status, "answered");
  assert.match(JSON.stringify(settled.parts), /selected/);
  assert.equal((await client.query(api.testing.run, { runId: result.runId }))!.hasToken, false);
}
