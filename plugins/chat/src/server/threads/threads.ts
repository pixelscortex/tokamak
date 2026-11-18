import { liveMachines } from "../machines/machines";
import { backend } from "../backends/backend";
import { listBackends } from "../backends/backends";
import { api } from "../_generated/api";
import { v } from "@tokamak/sdk";
import { DEFAULT_TITLE, action, mutation, nonempty, query, thread, usesMachineLink } from "../_functions";

export const list = query({
  handler: async (ctx) => {
    const { db, user } = ctx;
    const threads = await db.query("threads").withIndex("by_updatedAt").order("desc").collect();
    const selections = await db
      .query("selections")
      .withIndex("by_owner_thread", (q) => q.eq("owner", user.id))
      .collect();
    const remote = await usesMachineLink(ctx);
    const first = remote ? (await liveMachines(db, user.id)).flatMap((m) => m.agents)[0] : undefined;
    return threads.map((t) => {
      if (!remote) return t;
      const { backend: _backend, ...visible } = t;
      const selected =
        selections.find((s) => s.threadId === t._id)?.backend ??
        (first ? { kind: "plugin" as const, plugin: "acp", backendId: first.id } : undefined);
      return { ...visible, ...(selected ? { backend: selected } : {}) };
    });
  },
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
      for (const work of await db
        .query("work")
        .withIndex("by_runId", (q) => q.eq("runId", run._id))
        .collect())
        await db.delete(work._id);
      await db.delete(run._id);
    }
    for (const selection of await db.query("selections").collect())
      if (selection.threadId === threadId) await db.delete(selection._id);
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
    if (await usesMachineLink(ctx)) {
      const selected = { kind: "plugin" as const, plugin: backend.plugin, backendId: backend.backendId };
      const previous = (
        await db
          .query("selections")
          .withIndex("by_owner_thread", (q) => q.eq("owner", ctx.user.id).eq("threadId", threadId))
          .collect()
      )[0];
      if (previous) await db.patch(previous._id, { backend: selected });
      else await db.insert("selections", { threadId, owner: ctx.user.id, backend: selected });
      return null;
    }
    return db.patch(threadId, {
      backend,
      updatedAt: Date.now(),
    });
  },
});
