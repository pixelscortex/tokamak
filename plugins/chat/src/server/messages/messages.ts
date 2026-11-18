import { v } from "@tokamak/sdk";
import { DEFAULT_TITLE, mutation, nonempty, query, thread } from "../_functions";
import { jsonBytes } from "./parts";
import { recentMessages } from "./_tail";

const TRANSCRIPT_BYTES = 768 * 1024;

export const list = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const rows = [];
    let remaining = TRANSCRIPT_BYTES;
    for await (const message of recentMessages(ctx.db, threadId)) {
      let row = message;
      let size = jsonBytes(row) + 1;
      if (size > TRANSCRIPT_BYTES) {
        const pending = row.parts.filter((part) => part.type === "permission" && part.status === "pending");
        row = {
          ...row,
          parts: [
            { type: "text", text: "[Message too large to display]" },
            ...(jsonBytes(pending) < TRANSCRIPT_BYTES / 2 ? pending : []),
          ],
        };
        size = jsonBytes(row) + 1;
      }
      if (size > remaining) break;
      remaining -= size;
      rows.push(row);
    }
    return rows.reverse();
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
