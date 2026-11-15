import { v } from "@tokamak/sdk";
import { query } from "./_functions";

export const list = query({
  args: { threadId: v.id("threads") },
  handler: ({ db }, { threadId }) => db.query("messages")
    .withIndex("by_threadId_createdAt", q => q.eq("threadId", threadId)).collect(),
});
