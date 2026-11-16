import { canSee, owner } from "./access";
import { backend } from "./backend";
import { CHAT_MODELS, DEFAULT_MODEL } from "../models";
import { v } from "@tokamak/sdk";
import { DEFAULT_TITLE, mutation, nonempty, query, thread } from "./_functions";

export { share, shares, unshare } from "./shares";

export const list = query({
  guest: true,
  handler: async (ctx) => {
    if (ctx.caller.role === "owner")
      return ctx.db.query("threads").withIndex("by_updatedAt").order("desc").collect();
    const shares = await ctx.db
      .query("shares")
      .withIndex("by_member", (q) => q.eq("memberId", ctx.caller.memberId))
      .collect();
    const threads = [];
    for (const share of shares) {
      if (!(await canSee(ctx, share.threadId))) continue;
      const value = await ctx.db.get(share.threadId);
      if (value) threads.push(value);
    }
    return threads.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const create = mutation({
  args: { title: v.optional(v.string()) },
  handler: (ctx, { title }) => {
    owner(ctx);
    const { db, caller } = ctx;
    const now = Date.now();

    return db.insert("threads", {
      ownerId: caller.memberId,
      model: DEFAULT_MODEL,
      title: title === undefined ? DEFAULT_TITLE : nonempty(title),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const rename = mutation({
  args: { threadId: v.id("threads"), title: v.string() },
  handler: async (ctx, { threadId, title }) => {
    owner(ctx);
    const { db } = ctx;
    await thread(db, threadId);
    return db.patch(threadId, { title: nonempty(title), updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    owner(ctx);
    const { db } = ctx;
    for (const message of await db
      .query("messages")
      .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", threadId))
      .collect()) {
      await db.delete(message._id);
    }
    for (const run of await db
      .query("runs")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .collect()) {
      await db.delete(run._id);
    }
    for (const share of await db
      .query("shares")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect()) {
      await db.delete(share._id);
    }
    return db.delete(threadId);
  },
});

export const setModel = mutation({
  args: { threadId: v.id("threads"), model: v.string() },
  handler: async (ctx, { threadId, model }) => {
    owner(ctx);
    const { db } = ctx;
    const current = await thread(db, threadId);
    if (!CHAT_MODELS.some((choice) => choice === model)) throw new Error("Unknown chat model");

    return db.patch(threadId, {
      model,
      ...(current.backend ? { backend: { kind: "model" as const, model } } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const setBackend = mutation({
  args: { threadId: v.id("threads"), backend },
  handler: async (ctx, { threadId, backend }) => {
    owner(ctx);
    const { db } = ctx;
    const current = await thread(db, threadId);
    if (backend.kind === "model") {
      const selected = backend.model;
      if (!CHAT_MODELS.some((model) => model === selected)) throw new Error("Unknown chat model");
    }
    if (backend.kind === "acp") {
      const previous = current.backend;
      backend = {
        kind: "acp",
        agent: nonempty(backend.agent),
        cwd: nonempty(backend.cwd),
        ...(previous?.kind === "acp" &&
        previous.agent === backend.agent &&
        previous.cwd === backend.cwd &&
        previous.sessionId
          ? { sessionId: previous.sessionId }
          : {}),
      };
    }
    return db.patch(threadId, {
      backend,
      ...(backend.kind === "model" ? { model: backend.model } : {}),
      updatedAt: Date.now(),
    });
  },
});
