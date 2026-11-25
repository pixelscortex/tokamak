import { createFunctions, createHook, fail, v, type Id } from "@tokamak/sdk";
import * as team from "plugin:team/server";
import schema from "./schema";

const { query, mutation } = createFunctions(schema);
const hook = createHook(schema);

export const ban = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) => ctx.db.insert("bans", { name }),
});

export const moderate = hook(team.api.list, {
  async before(ctx, args) {
    if (args.mode === "blocked" && ctx.auth.user.role === "member") return fail("forbidden");
    if (args.mode === "wrong-args") return { ...args, text: 3 as unknown as string };
    if (args.mode === "added-arg") return { ...args, additional: true };
    if (args.mode === "stalled") await new Promise(() => {});
    if (args.mode === "throw") throw new Error("policy threw");
    if (args.mode === "recursive") await ctx.runQuery(team.api.list, args);
    if (args.mode === "foreign") await ctx.db.get(args.text as Id<"bans">);
    if (args.mode === "write") {
      const writer = ctx.db as unknown as { insert(table: string, value: { name: string }): Promise<string> };
      await writer.insert("bans", { name: "unexpected" });
    }
    return { ...args, text: args.text.trim() };
  },
  async after(ctx, users, args) {
    if (args.mode === "wrong-result") return null as unknown as typeof users;
    if (args.mode === "added-field") return users.map((user) => ({ ...user, additional: true }));
    const banned = new Set((await ctx.db.query("bans").collect()).map((ban) => ban.name));
    return users
      .filter(({ name }) => !banned.has(name))
      .map((user) => ({
        ...user,
        detail: `${args.text}|${ctx.auth.user.id}|${ctx.auth.user.role}|${ctx.call.threadId ?? ""}|${ctx.call.depth}`,
      }));
  },
});

export const delegated = query({
  args: { text: v.string() },
  handler: (ctx, args) => ctx.runQuery(team.api.list, args),
});
