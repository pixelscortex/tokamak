import { appendText, boundedError, toolUpdate, planPart, interruptTools } from "./parts";
import { applyToolUpdate } from "./tool-parts";
import { currentModel } from "../models";
import { v, type Infer } from "@tokamak/sdk";
import type { Part } from "./parts";
import { DEFAULT_TITLE, mutation, nonempty, query, thread } from "./_functions";

// Only chat.send uses these transactional steps; they are not plugin exports.
export const start = mutation({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async (ctx, { threadId, text }) => {
    const { db } = ctx;
    text = nonempty(text);
    const current = await thread(db, threadId);
    const backend = current.backend;
    const model = currentModel(current);
    const runs = await db
      .query("runs")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .collect();
    if (runs.some((run) => run.status === "running")) throw new Error("Thread already has an active run");

    const history = await db
      .query("messages")
      .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", threadId))
      .collect();
    // Milliseconds can tie across consecutive sends. Keep user before assistant
    // and preserve order without relying on randomly generated document IDs.
    const now = Math.max(Date.now(), (history.at(-1)?.createdAt ?? 0) + 1);

    await db.insert("messages", {
      threadId,
      role: "user",
      parts: [{ type: "text", text }],
      status: "complete",
      createdAt: now,
    });
    const messageId = await db.insert("messages", {
      threadId,
      role: "assistant",
      parts: [],
      status: "streaming",
      createdAt: now + 1,
    });
    const runId = await db.insert("runs", {
      threadId,
      messageId,
      status: "running",
      model,
      startedAt: Date.now(),
    });

    const title =
      history.length === 0 && current.title === DEFAULT_TITLE
        ? Array.from(text).slice(0, 80).join("")
        : current.title;
    await db.patch(threadId, { title, updatedAt: Date.now() });
    return {
      runId,
      messageId,
      model,
      ...(backend ? { backend } : {}),
      history: [
        ...history
          .filter((message) => message.status === "complete")
          .map((message) => ({
            role: message.role,
            content: message.parts
              .map((part) =>
                part.type === "text"
                  ? part.text
                  : part.type === "plan"
                    ? `[plan: ${part.entries.map((entry) => entry.content).join("; ")}]`
                    : part.type === "permission"
                      ? `[permission: ${part.title} (${part.status})]`
                      : `[tool ${part.toolName}: ${part.model ?? part.error ?? JSON.stringify(part.result ?? null)}]`,
              )
              .join(""),
          })),
        { role: "user" as const, content: text },
      ],
    };
  },
});

export const running = query({
  args: { runId: v.id("runs") },
  handler: async ({ db }, { runId }) => (await db.get(runId))?.status === "running",
});

export const update = mutation({
  args: {
    runId: v.id("runs"),
    delta: v.string(),
    outcome: v.optional(v.union(v.literal("done"), v.literal("error"), v.literal("cancelled"))),
    error: v.optional(v.string()),
    tool: v.optional(toolUpdate),
    upsertTools: v.optional(v.boolean()),
    plan: v.optional(planPart),
  },
  handler: async ({ db }, { runId, delta, outcome, error, tool, plan, upsertTools }) => {
    const run = await db.get(runId);
    if (!run || run.status !== "running") return "cancelled" as const;
    await db.patch(runId, { updatedAt: Date.now(), heartbeat: (run.heartbeat ?? 0) + 1 });
    if (![delta, outcome, tool, plan].some(Boolean)) return "running" as const;

    const message = await db.get(run.messageId);
    if (!message) throw new Error("Response message no longer exists");
    let parts = message.parts;
    if (delta) appendText(parts, delta);
    if (tool) applyToolUpdate(parts, tool, upsertTools);
    if (plan) replacePlan(parts, plan);
    if (outcome) parts = interruptTools(parts, unfinishedToolError(outcome, error));

    await db.patch(run.messageId, {
      parts,
      status: outcome ? messageStatus[outcome] : "streaming",
      ...(error === undefined ? {} : { error: boundedError(error) }),
    });
    await db.patch(run.threadId, { updatedAt: Date.now() });
    if (outcome) await db.patch(runId, { status: outcome, waiting: false, finishedAt: Date.now() });
    return outcome ?? "running";
  },
});

export const session = mutation({
  args: {
    threadId: v.id("threads"),
    plugin: v.string(),
    backendId: v.string(),
    settings: v.any(),
    state: v.any(),
  },
  handler: async ({ db }, { threadId, plugin, backendId, settings, state }) => {
    const current = await db.get(threadId);
    const backend = current?.backend;
    if (
      backend?.kind === "plugin" &&
      backend.plugin === plugin &&
      backend.backendId === backendId &&
      JSON.stringify(backend.settings ?? {}) === JSON.stringify(settings)
    )
      await db.patch(threadId, { backend: { ...backend, state } });
    return null;
  },
});

const messageStatus = { done: "complete", error: "error", cancelled: "cancelled" } as const;

function unfinishedToolError(outcome: "done" | "error" | "cancelled", error?: string) {
  if (outcome === "error") return boundedError(error ?? "Agent failed");
  return outcome === "cancelled" ? "cancelled" : "Tool did not complete";
}

function replacePlan(parts: Part[], plan: Infer<typeof planPart>) {
  const index = parts.findIndex((part) => part.type === "plan");
  if (index < 0) parts.push(plan);
  else parts[index] = plan;
}
