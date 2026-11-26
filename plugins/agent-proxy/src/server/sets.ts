import { fail, pluginOnly, v, type Doc, type Id, type QueryContext } from "@tokamak/sdk";
import { internal } from "./_generated/internal";
import {
  action,
  idIn,
  internalMutation,
  internalQuery,
  mutation,
  notFound,
  ownerOf,
  type Model,
} from "./_functions";
import { challenge, randomToken } from "./pkce";

const setId = v.string();
const ownerId = v.string();
const hashValue = v.string();
const TURN_KEY_TTL_MS = 8 * 60 * 60_000;

export function turnKeyHash(key: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(key) ? challenge(key) : null;
}

/** Keep the set's id when its owner changes the ordered list. */
export const registerSet = pluginOnly(
  mutation({
    args: { set: v.optional(setId), subscriptions: v.array(v.string()) },
    handler: async (ctx, { set, subscriptions }) => {
      const owner = ownerOf(ctx.auth);
      const ordered = new Set<Id<"subscriptions">>();
      for (const id of subscriptions) {
        const ref = idIn("subscriptions", id);
        const subscription = ref && (await ctx.db.get(ref));
        if (!subscription || subscription.owner !== owner) return notFound("subscription");
        ordered.add(subscription._id);
      }
      const fields = { owner, subscriptions: [...ordered] };
      if (set === undefined) {
        const id = await ctx.db.insert("sets", fields);
        return { set: id.slice(id.indexOf("/") + 1) };
      }
      const ref = idIn("sets", set);
      const row = ref && (await ctx.db.get(ref));
      if (!row || row.owner !== owner) return notFound("set");
      await ctx.db.replace(row._id, fields);
      return { set: row._id.slice(row._id.indexOf("/") + 1) };
    },
  }),
);

/** Removing the set also makes every outstanding key for it unusable. */
export const removeSet = pluginOnly(
  mutation({
    args: { set: setId },
    handler: async (ctx, { set }) => {
      const ref = idIn("sets", set);
      const row = ref && (await ctx.db.get(ref));
      if (!row || row.owner !== ownerOf(ctx.auth)) return notFound("set");
      await ctx.db.delete(row._id);
      return null;
    },
  }),
);

/** The raw credential only crosses the boundary back to the calling plugin. */
export const turnKey = pluginOnly(
  action({
    args: { set: setId },
    handler: async (ctx, { set }) => {
      const owner = ownerOf(ctx.auth);
      const origin = await ctx.server.url();
      if (!origin)
        return fail("MissingServerOrigin", { message: "Set TOKAMAK_PUBLIC_URL to hand out turn keys." });
      const key = randomToken();
      const saved = await ctx.runMutation(internal.sets.issue, { owner, set, hash: challenge(key) });
      if (!saved) return notFound("set");
      return { address: new URL(`/plugins/agent-proxy/${saved}`, origin).href, key };
    },
  }),
);

export const endTurnKey = pluginOnly(
  mutation({
    args: { key: v.string() },
    handler: async (ctx, { key }) => {
      const hash = turnKeyHash(key);
      if (!hash) return null;
      const row = await ctx.db
        .query("turnKeys")
        .withIndex("by_hash", (q) => q.eq("hash", hash))
        .first();
      if (row?.owner === ownerOf(ctx.auth)) await ctx.db.patch(row._id, { ended: true });
      return null;
    },
  }),
);

export const issue = internalMutation({
  args: { owner: ownerId, set: setId, hash: hashValue },
  handler: async (ctx, { owner, set, hash }) => {
    const id = idIn("sets", set);
    const row = id && (await ctx.db.get(id));
    if (!row || row.owner !== owner) return null;
    const now = Date.now();
    const expired = await ctx.db
      .query("turnKeys")
      .withIndex("by_owner_expiry", (q) => q.eq("owner", owner).lte("expiresAt", now))
      .take(100);
    for (const previous of expired) await ctx.db.delete(previous._id);
    await ctx.db.insert("turnKeys", { owner, set: row._id, hash, expiresAt: now + TURN_KEY_TTL_MS });
    return row._id.slice(row._id.indexOf("/") + 1);
  },
});

export const candidates = internalQuery({
  args: { set: setId, hash: hashValue },
  handler: async (ctx, { set, hash }) => {
    const key = await ctx.db
      .query("turnKeys")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .first();
    if (!key) return { ok: false as const, error: "Unknown turn key." };
    if (key.set !== idIn("sets", set))
      return { ok: false as const, error: "Turn key belongs to a different set." };
    if (key.ended) return { ok: false as const, error: "Turn key has ended." };
    const now = Date.now();
    if (key.expiresAt <= now) return { ok: false as const, error: "Turn key has expired." };
    const row = await ctx.db.get(key.set);
    if (!row || row.owner !== key.owner) return { ok: false as const, error: "Turn key has no set." };

    const availability = await eligibleAccounts(ctx, row, now);
    return { ok: true as const, owner: row.owner, ...availability };
  },
});

async function eligibleAccounts(ctx: QueryContext<Model>, row: Doc<Model, "sets">, now: number) {
  const accounts = [];
  let earliestReset = 0;
  for (const id of row.subscriptions) {
    const subscription = await ctx.db.get(id);
    if (!subscription?.enabled || subscription.owner !== row.owner || subscription.company !== "anthropic")
      continue;
    const members = await ctx.db
      .query("accounts")
      .withIndex("by_subscription", (q) => q.eq("subscription", id))
      .collect();
    for (const account of members) {
      if (account.owner !== row.owner || account.status !== "ok") continue;
      const until = account.limitedUntil ?? 0;
      if (until <= now) accounts.push({ id: account._id, subscription: id });
      else earliestReset = earliestReset ? Math.min(earliestReset, until) : until;
    }
  }
  return { accounts, earliestReset };
}

export const recordForward = internalMutation({
  args: {
    owner: ownerId,
    subscription: v.id("subscriptions"),
    account: v.id("accounts"),
    limitedUntil: v.number(),
    success: v.boolean(),
  },
  handler: async (ctx, { owner, subscription, account, limitedUntil, success }) => {
    const row = await ctx.db.get(subscription);
    if (row?.owner !== owner) return;
    const now = Date.now();
    if (success) await ctx.db.patch(subscription, { lastUsedAt: now });
    if (limitedUntil <= now) return;
    const member = await ctx.db.get(account);
    if (member?.owner === owner && limitedUntil > (member.limitedUntil ?? 0))
      await ctx.db.patch(account, { limitedUntil });
  },
});
