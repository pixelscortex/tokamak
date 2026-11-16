import { backend } from "./backend";
import { listBackends } from "./backends";
import { api } from "./_generated/api";
import { v } from "@tokamak/sdk";
import { DEFAULT_TITLE, action, mutation, nonempty, query, thread } from "./_functions";

export const list = query({
  handler: ({ db }) => db.query("threads").withIndex("by_updatedAt").order("desc").collect(),
});

export const create = action({
  args: { title: v.optional(v.string()) },
  handler: async (ctx, args): Promise<import("@tokamak/sdk").Id<"threads">> => {
    const first = (await listBackends(ctx))[0];
    return ctx.runMutation(api.threads.insert, {
      ...args,
      ...(first ? { backend: { kind: "plugin" as const, plugin: first.plugin, backendId: first.id } } : {}),
    });
  },
});

export const insert = mutation({
  args: { title: v.optional(v.string()), backend: v.optional(backend) },
  handler: (ctx, { title, backend }) => {
    const { db } = ctx;
    const now = Date.now();

    return db.insert("threads", {
      ...(backend ? { backend } : {}),
      title: title === undefined ? DEFAULT_TITLE : nonempty(title),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const rename = mutation({
  args: { threadId: v.id("threads"), title: v.string() },
  handler: async (ctx, { threadId, title }) => {
    const { db } = ctx;
    await thread(db, threadId);
    return db.patch(threadId, { title: nonempty(title), updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
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
    return db.delete(threadId);
  },
});

export const setBackend = mutation({
  args: { threadId: v.id("threads"), backend },
  handler: async (ctx, { threadId, backend }) => {
    const { db } = ctx;
    const current = await thread(db, threadId);
    if (backend.kind === "plugin") {
      const previous = current.backend;
      const { state: _state, ...selected } = backend;
      backend = {
        ...selected,
        plugin: nonempty(backend.plugin),
        backendId: nonempty(backend.backendId),
        ...(previous?.kind === "plugin" &&
        previous.plugin === backend.plugin &&
        previous.backendId === backend.backendId &&
        JSON.stringify(previous.settings ?? {}) === JSON.stringify(backend.settings ?? {}) &&
        previous.state !== undefined
          ? { state: previous.state }
          : {}),
      };
    }
    return db.patch(threadId, {
      backend,
      updatedAt: Date.now(),
    });
  },
});
