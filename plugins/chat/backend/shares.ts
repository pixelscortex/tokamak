import { v } from "@tokamak/sdk";
import { mutation, thread } from "./_functions";
import { owner } from "./access";

const args = { threadId: v.id("threads"), memberId: v.string() };

export const share = mutation({
  args,
  handler: async (ctx, { threadId, memberId }) => {
    owner(ctx);
    await thread(ctx.db, threadId);
    const shares = await ctx.db.query("shares").withIndex("by_thread", q => q.eq("threadId", threadId)).collect();
    if (!shares.some(share => share.memberId === memberId)) await ctx.db.insert("shares", { threadId, memberId });
    return null;
  },
});

export const unshare = mutation({
  args,
  handler: async (ctx, { threadId, memberId }) => {
    owner(ctx);
    const shares = await ctx.db.query("shares").withIndex("by_thread", q => q.eq("threadId", threadId)).collect();
    for (const share of shares) if (share.memberId === memberId) await ctx.db.delete(share._id);
    return null;
  },
});
