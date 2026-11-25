import { createFunctions, createHook, fail, provide, v, type Id } from "@tokamak/sdk";
import { directory } from "plugin:team/contracts";
import * as team from "plugin:team/server";
import schema from "./schema";

const { query, mutation, action, internalQuery } = createFunctions(schema);
const hook = createHook(schema);

export const ban = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) => ctx.db.insert("bans", { name }),
});

export const moderate = hook(team.api.list, {
  async before(ctx, args) {
    if (args.mode === "blocked" && ctx.auth.user.role === "member")
      return fail("forbidden", { reason: "members" });
    if (args.mode === "wrong-args") return { ...args, text: 3 as unknown as string };
    if (args.mode === "added-arg") return { ...args, additional: true };
    if (args.mode === "stalled") await new Promise(() => {});
    if (args.mode === "throw") throw new Error("policy threw: depth limit is just text");
    if (args.mode === "budget") {
      for (let i = 0; i < 129; i++) await ctx.runQuery(team.api.ping, {});
    }
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

export const editProfile = hook(team.api.profile, {
  after(_ctx, result, { mode }) {
    const location: [string, number, boolean] = [
      "new",
      1,
      mode === "bad-location" ? ("invalid" as unknown as boolean) : true,
    ];
    return {
      ...result,
      title: mode === "bad-title" ? (0 as unknown as string) : "Title",
      alias: mode === "bad-alias" ? (false as unknown as string) : "Alias",
      status: mode === "bad-status" ? ("invalid" as "active") : "active",
      labels: ["new"],
      extras: { fresh: ["data"] },
      location,
    };
  },
});

export const fanout = query({
  async handler(ctx) {
    let count = 0;
    for (let i = 0; i < 70; i++) count += (await ctx.runQuery(team.api.list, { text: " Ali " })).length;
    return count;
  },
});

export const fromMutation = mutation({
  handler: (ctx) => ctx.runQuery(team.api.list, { text: " Ali " }),
});

export const catchFailure = query({
  async handler(ctx) {
    try {
      await ctx.runQuery(team.api.list, { text: "", mode: "blocked" });
    } catch (error) {
      if (error instanceof Error && "kind" in error && "plugin" in error && "data" in error) {
        return { kind: String(error.kind), plugin: String(error.plugin), data: error.data };
      }
      throw error;
    }
    throw new Error("expected failure");
  },
});

export const fromAction = action({
  async handler(ctx) {
    const rows = await ctx.runQuery(team.api.list, { text: " Ali " });
    try {
      await ctx.runQuery(team.api.list, { text: "", mode: "blocked" });
    } catch (error) {
      if (error instanceof Error && "kind" in error && "plugin" in error && "data" in error) {
        return { rows, kind: String(error.kind), plugin: String(error.plugin), data: error.data };
      }
      throw error;
    }
    throw new Error("expected failure");
  },
});

export const editExplicit = hook(team.api.explicit, {
  after: () => ({ status: "active" }),
});

export const filterRows = hook(team.api.rows, {
  after: (_ctx, rows) => rows.filter(({ name }) => name === "Alice"),
});

export const directoryProvider = provide(directory, {
  list: internalQuery({
    args: { text: v.string() },
    handler: (ctx, args) => ctx.runQuery(team.api.list, args),
  }),
});

export const hookBudget = query({
  async handler(ctx) {
    for (let i = 0; i < 2; i++) await ctx.runQuery(team.api.list, { text: "", mode: "budget" });
  },
});

export const stallsAfterCaughtHook = query({
  async handler(ctx) {
    try {
      await ctx.runQuery(team.api.list, { text: "", mode: "throw" });
    } catch {
      await new Promise(() => {});
    }
  },
});
