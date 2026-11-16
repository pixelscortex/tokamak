import { canSee } from "./access";
import { v } from "@tokamak/sdk";
import { query } from "./_functions";

export const list = query({
  guest: true,
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    if (!await canSee(ctx, threadId)) return [];
    return ctx.db.query("messages").withIndex("by_threadId_createdAt", q => q.eq("threadId", threadId)).collect();
  },
});
