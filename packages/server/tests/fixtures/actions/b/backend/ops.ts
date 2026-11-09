/// <reference lib="dom" />
import { action, mutation, query, v } from "@tokamak/sdk";
export const publicRead = query({ handler: () => "public" });
export const privateRead = query({ handler: () => "private" });
export const privateWrite = mutation({ handler: ctx => ctx.db.insert("private", { value: "denied" }) });
export const deniedFetch = action({
  args: { url: v.string() },
  handler: async (_ctx, { url }) => (await fetch(url)).text(),
});
