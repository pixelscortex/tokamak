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
    if (runs.some(run => run.status === "running")) throw new Error("Thread already has an active run");

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
        role: message.role, content: message.parts.map(part => part.text).join(""),
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
  },
  handler: async ({ db }, { runId, delta, outcome, error }) => {
    const run = await db.get(runId);
    if (!run || run.status !== "running") return "cancelled" as const;
    const message = await db.get(run.messageId);
    if (!message) throw new Error("Response message no longer exists");
    const text = message.parts.map(part => part.text).join("") + delta;
    await db.patch(run.messageId, {
      parts: [{ type: "text", text }],
      status: outcome === "done" ? "complete" : outcome === "error" ? "error" : "streaming",
      ...(error === undefined ? {} : { error }),
    });
    await db.patch(run.threadId, { updatedAt: Date.now() });
    if (outcome) await db.patch(runId, { status: outcome, finishedAt: Date.now() });
    return outcome ?? "running";
  },
});
