import { appendText, boundedError, toolUpdate, planPart, interruptTools } from "../messages/parts";
import { applyToolUpdate } from "../messages/tool-parts";
import { boundedThreadHistory, v, type Infer } from "@tokamak/sdk";
import type { Part } from "../messages/parts";
import { DEFAULT_TITLE, mutation, nonempty, query, thread, turn } from "../_functions";

export const start = mutation({
  args: {
    threadId: v.id("threads"),
    text: v.string(),
    token: v.string(),
    relay: v.optional(v.object({ backendId: v.string(), requestId: v.string() })),
  },
  handler: async (ctx, { threadId, text, token, relay }) => {
    const { db } = ctx;
    const owner = { id: ctx.user.id, name: ctx.user.name };
    const current = await thread(db, threadId);
    if (!relay && owner.id !== "local")
      throw new Error("Agents run from the desktop app on your own computer.");
    if (relay && (!/^[0-9a-f]{64}$/.test(token) || !relay.requestId || relay.requestId.length > 128))
      throw new Error("Invalid relayed turn credentials");
    const backend = relay
      ? {
          kind: "plugin" as const,
          plugin: "acp",
          backendId: nonempty(relay.backendId),
          settings: {},
          state: null,
        }
      : current.backend;
    if (!backend) throw new Error("No agents found. Install `claude-agent-acp` or `codex-acp` (see README)");
    const runs = await db
      .query("runs")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .collect();
    const previous =
      relay && runs.find((run) => run.owner?.id === owner.id && run.requestId === relay.requestId);
    const resumedStart =
      previous &&
      previous.status === "running" &&
      previous.token === token &&
      previous.backendId === backend.backendId;
    if (previous && !resumedStart)
      return {
        started: false as const,
        runId: previous._id,
        messageId: previous.messageId,
        status: previous.status,
      };
    if (
      !resumedStart &&
      runs.some(
        (run) =>
          run.status === "running" &&
          (run.owner?.id ?? "local") === owner.id &&
          (run.backendId === undefined ||
            (run.backendPlugin === backend.plugin && run.backendId === backend.backendId)),
      )
    )
      throw new Error("Thread already has an active run for this agent");
    text = nonempty(text);

    const history = await db
      .query("messages")
      .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", threadId))
      .collect();
    const priorReply = previous && history.find((message) => message._id === previous.messageId);
    const before = priorReply
      ? history.filter((message) => message.createdAt < priorReply.createdAt - 1)
      : history;
    const records = before
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
        ...(relay ? { author: message.author ?? message.askedBy ?? { id: "unknown", name: "Unknown" } } : {}),
      }));
    const historyResult = relay
      ? boundedThreadHistory(records)
      : [...records, { role: "user", content: text }];
    const members = relay
      ? [
          ...new Map(
            before.flatMap((message) => {
              const author = message.author ?? message.askedBy;
              return author && author.id !== owner.id ? [[author.id, author.name] as const] : [];
            }),
          ).values(),
        ].slice(0, 64)
      : [];
    const details = {
      started: true as const,
      backend,
      history: historyResult,
      owner,
      members,
    };
    if (previous) return { ...details, runId: previous._id, messageId: previous.messageId };

    // Milliseconds can tie across consecutive sends. Keep user before assistant
    // and preserve order without relying on randomly generated document IDs.
    const now = Math.max(Date.now(), (history.at(-1)?.createdAt ?? 0) + 1);

    await db.insert("messages", {
      threadId,
      role: "user",
      author: owner,
      parts: [{ type: "text", text }],
      status: "complete",
      createdAt: now,
    });
    const messageId = await db.insert("messages", {
      threadId,
      role: "assistant",
      askedBy: owner,
      parts: [],
      status: "streaming",
      agent: { plugin: backend.plugin, backendId: backend.backendId },
      createdAt: now + 1,
    });
    const runId = await db.insert("runs", {
      threadId,
      messageId,
      status: "running",
      token,
      backendPlugin: backend.plugin,
      backendId: backend.backendId,
      owner,
      ...(relay ? { requestId: relay.requestId, sequence: 0 } : {}),
      startedAt: Date.now(),
    });

    const title =
      history.length === 0 && current.title === DEFAULT_TITLE
        ? Array.from(text).slice(0, 80).join("")
        : current.title;
    await db.patch(threadId, { title, updatedAt: Date.now() });
    return { ...details, runId, messageId };
  },
});

export const running = query({
  args: { runId: v.id("runs") },
  handler: async ({ db }, { runId }) => (await db.get(runId))?.status === "running",
});

export const update = mutation({
  args: {
    runId: v.id("runs"),
    token: v.string(),
    delta: v.string(),
    sequence: v.optional(v.number()),
    outcome: v.optional(v.union(v.literal("done"), v.literal("error"), v.literal("cancelled"))),
    error: v.optional(v.string()),
    tool: v.optional(toolUpdate),
    upsertTools: v.optional(v.boolean()),
    plan: v.optional(planPart),
  },
  handler: async (ctx, { runId, token, delta, sequence, outcome, error, tool, plan, upsertTools }) => {
    const { db } = ctx;
    const prior = await db.get(runId);
    if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1))
      throw new Error("Invalid run update sequence");
    if (
      prior?.token === token &&
      prior.owner?.id === ctx.user.id &&
      sequence !== undefined &&
      sequence <= (prior.sequence ?? 0)
    )
      return prior.status;
    const run = await turn(ctx, runId, token);
    if (run.requestId && sequence === undefined) throw new Error("Run update sequence required");
    await db.patch(runId, {
      updatedAt: Date.now(),
      heartbeat: (run.heartbeat ?? 0) + 1,
      ...(sequence === undefined ? {} : { sequence }),
    });
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
    if (outcome)
      await db.patch(runId, {
        status: outcome,
        // A lost terminal response may be retried, but only the owner with this token can replay it.
        ...(sequence === undefined ? { token: null } : {}),
        waiting: false,
        finishedAt: Date.now(),
      });
    return outcome ?? "running";
  },
});

export const session = mutation({
  args: {
    runId: v.id("runs"),
    token: v.string(),
    threadId: v.id("threads"),
    plugin: v.string(),
    backendId: v.string(),
    settings: v.any(),
    state: v.any(),
  },
  handler: async (ctx, { runId, token, threadId, plugin, backendId, settings, state }) => {
    const { db } = ctx;
    const run = await turn(ctx, runId, token);
    if (run.requestId) throw new Error("Relayed session state stays on the agent machine");
    if (run.threadId !== threadId || run.backendPlugin !== plugin) throw new Error("Turn backend mismatch");
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
