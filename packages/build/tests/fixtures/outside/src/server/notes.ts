import { mutation, query, v } from "@tokamak/sdk";
import type { api } from "./_generated/api";

export const list = query({ handler: (ctx) => ctx.db.query("notes").collect() });
export const add = mutation({
  args: { text: v.string() },
  handler: (ctx, { text }) => ctx.db.insert("notes", { text }),
});

export type ListReference = typeof api.notes.list;
