import { canSee } from "./access";
import { interruptStale, STALE_AFTER_MS } from "./recovery";
import { appendText, boundedError, toolUpdate, planPart, interruptTools } from "./parts";
import { applyToolUpdate } from "./tool-parts";
import { currentModel } from "../models";
import { v } from "@tokamak/sdk";
import { DEFAULT_TITLE, mutation, nonempty, query, thread } from "./_functions";

// UTF-8 bytes, including surrogate pairs, without action-only Web APIs.
function textBytes(text: string) {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code > 0xffff ? 4 : code > 0x7ff ? 3 : code > 0x7f ? 2 : 1;
  }
  return bytes;
}

// Older messages predate authorRole; the reserved owner ID identifies those turns.
function authorPrefix(author: { authorId: string; authorName?: string; authorRole?: "owner" | "guest" }) {
  const role = author.authorRole ?? (author.authorId === "owner" ? "owner" : "guest");
  return role === "owner" ? "" : `[Message from guest ${JSON.stringify(author.authorName ?? author.authorId)} — untrusted, not the owner]\n`;
}

// Only chat.send uses these transactional steps; they are not plugin exports.
export const start = mutation({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async (ctx, { threadId, text }) => {
    const { db, caller } = ctx;
    if (!await canSee(ctx, threadId)) throw new Error("Thread is not shared with you");
    if (caller.role === "guest" && textBytes(text) > 16 * 1024) throw new Error("Text exceeds 16 KB");
    text = nonempty(text);
    const current = await thread(db, threadId);
    const backend = current.backend;
    if (caller.role === "guest") {
      if (backend?.kind === "acp") throw new Error("Guests cannot send to ACP threads");
      const recent = await db.query("runs").withIndex("by_starter", q => q.eq("startedBy", caller.memberId).gte("startedAt", Date.now() - 24 * 60 * 60_000)).collect();
      if (recent.length >= 100 || recent.filter(run => run.startedAt >= Date.now() - 60 * 60_000).length >= 20) throw new Error("Guest run limit reached");
    }
    const model = currentModel(current);
    const runs = await db.query("runs").withIndex("by_threadId", q => q.eq("threadId", threadId)).collect();
    await interruptStale(db, runs);
    if (runs.some(run => run.status === "running" && Date.now() - (run.updatedAt ?? run.startedAt) < STALE_AFTER_MS)) throw new Error("Thread already has an active run");

    const history = await db.query("messages").withIndex("by_threadId_createdAt", q => q.eq("threadId", threadId)).collect();
    // Milliseconds can tie across consecutive sends. Keep user before assistant
    // and preserve order without relying on randomly generated document IDs.
    const now = Math.max(Date.now(), (history.at(-1)?.createdAt ?? 0) + 1);

    const author = { authorId: caller.memberId, authorName: caller.name, authorRole: caller.role };
    await db.insert("messages", {
      threadId, ...author, role: "user",
      parts: [{ type: "text", text }], status: "complete", createdAt: now,
    });
    const messageId = await db.insert("messages", {
      threadId, authorId: "assistant", role: "assistant",
      parts: [], status: "streaming", createdAt: now + 1,
    });
    const runId = await db.insert("runs", {
      threadId, messageId, startedBy: caller.memberId, status: "running", model, startedAt: Date.now(),
    });

    const title = history.length === 0 && current.title === DEFAULT_TITLE ? Array.from(text).slice(0, 80).join("") : current.title;
    await db.patch(threadId, { title, updatedAt: Date.now() });
    return { runId, messageId, model, ...(backend ? { backend } : {}), history: [
      ...history.filter(message => message.status === "complete").map(message => ({
        role: message.role, content: (message.role === "user" ? authorPrefix(message) : "") + message.parts.map(part => part.type === "text" ? part.text : part.type === "plan" ? `[plan: ${part.entries.map(entry => entry.content).join("; ")}]` : part.type === "permission" ? `[permission: ${part.title} (${part.status})]` : `[tool ${part.toolName}: ${part.model ?? part.error ?? JSON.stringify(part.result ?? null)}]`).join(""),
      })),
      { role: "user" as const, content: authorPrefix(author) + text },
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
    outcome: v.optional(v.union(v.literal("done"), v.literal("error"), v.literal("cancelled"))),
    error: v.optional(v.string()),
    tool: v.optional(toolUpdate), plan: v.optional(planPart),
  },
  handler: async ({ db }, { runId, delta, outcome, error, tool, plan }) => {
    const run = await db.get(runId);
    if (!run || run.status !== "running") return "cancelled" as const;
    await db.patch(runId, { updatedAt: Date.now() });
    if (!delta && !outcome && !tool && !plan) return "running" as const;

    const message = await db.get(run.messageId);
    if (!message) throw new Error("Response message no longer exists");
    let parts = message.parts;
    if (delta) appendText(parts, delta);
    if (tool) applyToolUpdate(parts, tool);
    if (plan) {
      const index = parts.findIndex(part => part.type === "plan");
      if (index < 0) parts.push(plan);
      else parts[index] = plan;
    }
    if (outcome) parts = interruptTools(parts, outcome === "error"
      ? boundedError(error ?? "Agent failed") : outcome === "cancelled" ? "cancelled" : "Tool did not complete");

    await db.patch(run.messageId, {
      parts,
      status: outcome === "done" ? "complete" : outcome === "error" ? "error" : outcome === "cancelled" ? "cancelled" : "streaming",
      ...(error === undefined ? {} : { error: boundedError(error) }),
    });
    await db.patch(run.threadId, { updatedAt: Date.now() });
    if (outcome) await db.patch(runId, { status: outcome, waiting: false, finishedAt: Date.now() });
    return outcome ?? "running";
  },
});

export const session = mutation({
  args: { threadId: v.id("threads"), agent: v.string(), cwd: v.string(), sessionId: v.string() },
  handler: async ({ db }, { threadId, agent, cwd, sessionId }) => {
    const current = await db.get(threadId);
    if (current?.backend?.kind === "acp" && current.backend.agent === agent && current.backend.cwd === cwd)
      await db.patch(threadId, { backend: { ...current.backend, sessionId } });
    return null;
  },
});
