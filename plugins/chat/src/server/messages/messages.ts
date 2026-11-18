import { v } from "@tokamak/sdk";
import { DEFAULT_TITLE, mutation, nonempty, query, thread } from "../_functions";

export const list = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    return ctx.db
      .query("messages")
      .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", threadId))
      .collect();
  },
});

export const post = mutation({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async ({ db, user }, { threadId, text }) => {
    const current = await thread(db, threadId);
    const content = nonempty(text);
    const last = await db
      .query("messages")
      .withIndex("by_threadId_createdAt", (q) => q.eq("threadId", threadId))
      .order("desc")
      .first();
    await db.insert("messages", {
      threadId,
      role: "user",
      author: { id: user.id, name: user.name },
      parts: [{ type: "text", text: content }],
      status: "complete",
      createdAt: Math.max(Date.now(), (last?.createdAt ?? 0) + 1),
    });
    return db.patch(threadId, {
      updatedAt: Date.now(),
      ...(!last && current.title === DEFAULT_TITLE
        ? { title: Array.from(content).slice(0, 80).join("") }
        : {}),
    });
  },
});
