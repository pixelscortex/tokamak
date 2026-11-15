import { interruptStale, STALE_AFTER_MS } from "./recovery";
import { boundedError, checkToolArgs, jsonBytes, toolUpdate, type ToolPart } from "./parts";
import { DEFAULT_MODEL } from "../models";
import { v } from "@tokamak/sdk";
import { DEFAULT_TITLE, OWNER, mutation, nonempty, query, thread } from "./_functions";

// Only chat.send uses these transactional steps; they are not plugin exports.
export const start = mutation({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async ({ db }, { threadId, text }) => {
    text = nonempty(text);
    const current = await thread(db, threadId);
    const model = current.model ?? DEFAULT_MODEL;
    const runs = await db.query("runs").withIndex("by_threadId", q => q.eq("threadId", threadId)).collect();
    await interruptStale(db, runs);
    if (runs.some(run => run.status === "running" && Date.now() - (run.updatedAt ?? run.startedAt) < STALE_AFTER_MS)) throw new Error("Thread already has an active run");

    const history = await db.query("messages").withIndex("by_threadId_createdAt", q => q.eq("threadId", threadId)).collect();
    // Milliseconds can tie across consecutive sends. Keep user before assistant
    // and preserve order without relying on randomly generated document IDs.
    const now = Math.max(Date.now(), (history.at(-1)?.createdAt ?? 0) + 1);

    await db.insert("messages", {
      threadId, authorId: OWNER, role: "user",
      parts: [{ type: "text", text }], status: "complete", createdAt: now,
    });
    const messageId = await db.insert("messages", {
      threadId, authorId: "assistant", role: "assistant",
      parts: [], status: "streaming", createdAt: now + 1,
    });
    const runId = await db.insert("runs", {
      threadId, messageId, startedBy: OWNER, status: "running", model, startedAt: Date.now(),
    });

    const title = history.length === 0 && current.title === DEFAULT_TITLE ? Array.from(text).slice(0, 80).join("") : current.title;
    await db.patch(threadId, { title, updatedAt: Date.now() });
    return { runId, messageId, model, history: [
      ...history.filter(message => message.status === "complete").map(message => ({
        role: message.role, content: message.parts.map(part => part.type === "text" ? part.text : `[tool ${part.toolName}: ${part.model ?? part.error ?? JSON.stringify(part.result ?? null)}]`).join(""),
      })),
      { role: "user" as const, content: text },
    ] };
  },
});

export const running = query({
  args: { runId: v.id("runs") },
  handler: async ({ db }, { runId }) => (await db.get(runId))?.status === "running",
});

export const update = mutation({
  args: {
    runId: v.id("runs"), delta: v.string(),
    outcome: v.optional(v.union(v.literal("done"), v.literal("error"))),
    error: v.optional(v.string()),
    tool: v.optional(toolUpdate),
  },
  handler: async ({ db }, { runId, delta, outcome, error, tool }) => {
    const run = await db.get(runId);
    if (!run || run.status !== "running") return "cancelled" as const;
    await db.patch(runId, { updatedAt: Date.now() });
    if (!delta && !outcome && !tool) return "running" as const;

    const message = await db.get(run.messageId);
    if (!message) throw new Error("Response message no longer exists");
    const parts = message.parts;
    if (delta) {
      const last = parts.at(-1);
      if (last?.type === "text") last.text += delta;
      else parts.push({ type: "text", text: delta });
    }
    if (tool) {
      const patch = { ...tool };
      if (patch.args !== undefined) checkToolArgs(patch.args);
      if (patch.error !== undefined) patch.error = boundedError(patch.error);
      if (patch.result !== undefined) {
        if (jsonBytes(patch.result) > 8 * 1024) patch.result = { truncated: true };
      }
      const existing = parts.find(part => part.type === "tool" && part.callId === patch.callId);
      if (existing?.type === "tool") {
        if (patch.status === "running") throw new Error(`Duplicate tool callId: ${patch.callId}`);
        if (existing.status !== "running") throw new Error("Tool is already settled");
        if ((patch.plugin !== undefined && patch.plugin !== existing.plugin) ||
            (patch.toolName !== undefined && patch.toolName !== existing.toolName))
          throw new Error("Tool identity is immutable");
        const { callId: _callId, plugin: _plugin, toolName: _toolName, args: _args, ...completion } = patch;
        Object.assign(existing, completion);
      }
      else {
        if (patch.status !== "running") throw new Error("New tool part must be running");
        if (patch.plugin === undefined || patch.toolName === undefined || patch.args === undefined)
          throw new Error("New tool part requires plugin, toolName and args");
        parts.push({ type: "tool", ...patch } as ToolPart);
      }
    }
    await db.patch(run.messageId, {
      parts,
      status: outcome === "done" ? "complete" : outcome === "error" ? "error" : "streaming",
      ...(error === undefined ? {} : { error: boundedError(error) }),
    });
    await db.patch(run.threadId, { updatedAt: Date.now() });
    if (outcome) await db.patch(runId, { status: outcome, finishedAt: Date.now() });
    return outcome ?? "running";
  },
});
