import { v } from "@tokamak/sdk";
import { DEFAULT_TITLE, OWNER, mutation, nonempty, query, thread } from "./_functions";

export const list = query({
  handler: ({ db }) => db.query("threads").withIndex("by_updatedAt").order("desc").collect(),
});

export const create = mutation({
  args: { title: v.optional(v.string()) },
  handler: ({ db }, { title }) => {
    const now = Date.now();

    return db.insert("threads", {
      ownerId: OWNER,
      title: title === undefined ? DEFAULT_TITLE : nonempty(title),
      createdAt: now, updatedAt: now,
    });
  },
});

export const rename = mutation({
  args: { threadId: v.id("threads"), title: v.string() },
  handler: async ({ db }, { threadId, title }) => {
    await thread(db, threadId);
    return db.patch(threadId, { title: nonempty(title), updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { threadId: v.id("threads") },
  handler: async ({ db }, { threadId }) => {
    for (const message of await db.query("messages").withIndex("by_threadId_createdAt", q => q.eq("threadId", threadId)).collect()) {
      await db.delete(message._id);
    }
    for (const run of await db.query("runs").withIndex("by_threadId", q => q.eq("threadId", threadId)).collect()) {
      await db.delete(run._id);
    }
    return db.delete(threadId);
  },
});
