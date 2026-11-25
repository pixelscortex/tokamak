import { fail, isFailure, pluginOnly, v, type Id } from "@tokamak/sdk";
import type {} from "@tokamak/sdk/web";
import { internal } from "./_generated/internal";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  ownerOf,
  viewOf,
  type SignInView,
  type SubscriptionView,
} from "./_functions";
import { companyAddresses } from "./addresses";
import { SignInError, exchange, models, profile, readPasted, signInLink } from "./claude";
import { randomToken } from "./pkce";

/**
 * Adding a subscription, or signing one in again. The server makes the link
 * and keeps the PKCE verifier; the person signs in on Claude's page and pastes
 * back what it ends on; the server trades that for the login. The sign-in is
 * a row, so it lives on when the dialog closes and can be cancelled from the
 * "Awaiting sign-in" card. Whatever ends it (done, cancelled, refused) removes
 * the row, and only a finished sign-in ever writes a subscription.
 *
 * These are plugin-only: the window reaches them through `ai-profiles`, and
 * no result carries the login, the verifier or anything read from them.
 */

const signInId = v.id("signIns");

/** One "Awaiting sign-in" per target: starting again replaces the unfinished one. */
export const begin = internalMutation({
  args: {
    verifier: v.string(),
    state: v.string(),
    link: v.string(),
    repair: v.optional(v.id("subscriptions")),
  },
  handler: async (ctx, { verifier, state, link, repair }) => {
    const owner = ownerOf(ctx.auth);
    if (repair) {
      const subscription = await ctx.db.get(repair);
      if (!subscription || subscription.owner !== owner)
        return fail("Gone", { message: "That subscription is gone." });
    }
    const open = await ctx.db
      .query("signIns")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .collect();
    for (const row of open) if (row.repair === repair) await ctx.db.delete(row._id);
    const startedAt = Date.now();
    const id = await ctx.db.insert("signIns", {
      owner,
      company: "anthropic",
      method: "subscription",
      verifier,
      state,
      link,
      startedAt,
      ...(repair && { repair }),
    });
    const started: SignInView = {
      id,
      company: "anthropic",
      method: "subscription",
      link,
      startedAt,
      ...(repair && { repair }),
    };
    return started;
  },
});

/** Makes the sign-in link: Anthropic, Claude subscription (API keys come later). */
export const startSignIn = pluginOnly(
  action({
    args: {
      company: v.literal("anthropic"),
      method: v.literal("subscription"),
      /** A signed-out subscription to repair in place instead of adding a new one. */
      repair: v.optional(v.string()),
    },
    handler: async (ctx, { repair }) => {
      const verifier = randomToken();
      const state = randomToken();
      const link = signInLink(await companyAddresses(ctx), verifier, state);
      return ctx.runMutation(internal.signins.begin, {
        verifier,
        state,
        link,
        ...(repair !== undefined && { repair: repair as Id<"subscriptions"> }),
      });
    },
  }),
);

/** The caller's sign-in, with its verifier; internal, for `finishSignIn` only. */
export const pending = internalQuery({
  args: { id: signInId },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    return row && row.owner === ownerOf(ctx.auth) ? row : null;
  },
});

/** Ends a sign-in without a subscription; false when it had already ended. */
export const drop = internalMutation({
  args: { id: signInId },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row || row.owner !== ownerOf(ctx.auth)) return false;
    await ctx.db.delete(id);
    return true;
  },
});

/** Stops waiting. Nothing was stored for it, so nothing else is removed. */
export const cancelSignIn = pluginOnly(
  mutation({
    args: { id: v.string() },
    handler: async (ctx, { id }) => {
      const row = await ctx.db.get(id as Id<"signIns">);
      if (row && row.owner === ownerOf(ctx.auth)) await ctx.db.delete(row._id);
      return null;
    },
  }),
);

const model = v.object({ id: v.string(), name: v.string() });

/**
 * Stores what the sign-in brought, in one transaction with ending it. The
 * sign-in must still be waiting: a cancel that came while Claude answered wins,
 * and the login is dropped.
 */
export const connect = internalMutation({
  args: {
    id: signInId,
    accountId: v.string(),
    email: v.optional(v.string()),
    organization: v.optional(v.string()),
    plan: v.string(),
    models: v.array(model),
    access: v.string(),
    refresh: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, { id, access, refresh, expiresAt, ...found }) => {
    const owner = ownerOf(ctx.auth);
    const signIn = await ctx.db.get(id);
    if (!signIn || signIn.owner !== owner)
      return fail("Cancelled", { message: "The sign-in was cancelled. Nothing was added." });
    await ctx.db.delete(id);
    const same = await ctx.db
      .query("accounts")
      .withIndex("by_owner_account", (q) => q.eq("owner", owner).eq("accountId", found.accountId))
      .first();
    const identity = {
      ...(found.email !== undefined && { email: found.email }),
      ...(found.organization !== undefined && { organization: found.organization }),
    };
    let subscriptionId: Id<"subscriptions">;
    let accountId: Id<"accounts">;
    if (signIn.repair) {
      const subscription = await ctx.db.get(signIn.repair);
      if (!subscription || subscription.owner !== owner)
        return fail("Gone", { message: "That subscription was removed meanwhile. Nothing was added." });
      if (!same || same.subscription !== subscription._id)
        return fail("OtherAccount", {
          message: `You signed in as ${found.email ?? "another account"}, not the account of this subscription. Sign in with that account.`,
        });
      subscriptionId = subscription._id;
      accountId = same._id;
      await ctx.db.patch(same._id, { ...identity, status: "ok" });
      await ctx.db.patch(subscription._id, { plan: found.plan, models: found.models });
      const old = await ctx.db
        .query("logins")
        .withIndex("by_account", (q) => q.eq("account", same._id))
        .first();
      if (old) await ctx.db.delete(old._id);
    } else {
      if (same) {
        const existing = await ctx.db.get(same.subscription);
        return fail("AlreadyAdded", {
          message: `${found.email ?? "This account"} is already added${existing?.label ? ` as "${existing.label}"` : ""}.`,
        });
      }
      subscriptionId = await ctx.db.insert("subscriptions", {
        owner,
        company: "anthropic",
        method: "subscription",
        label: "",
        plan: found.plan,
        enabled: true,
        models: found.models,
        createdAt: Date.now(),
      });
      accountId = await ctx.db.insert("accounts", {
        owner,
        subscription: subscriptionId,
        accountId: found.accountId,
        ...identity,
        status: "ok",
      });
    }
    await ctx.db.insert("logins", { owner, account: accountId, access, refresh, expiresAt });
    const subscription = (await ctx.db.get(subscriptionId))!;
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_subscription", (q) => q.eq("subscription", subscriptionId))
      .collect();
    return viewOf(subscription, accounts);
  },
});

type Failed = { failed: true; kind: string; data: { message: string } };

/**
 * Finishes a sign-in with what the person pasted: the link the browser ended
 * on, or Claude's `code#state`. A paste that cannot be read, or that belongs to
 * another sign-in, leaves the sign-in waiting for another try; a code Claude
 * refuses ends it, since a code works once.
 */
export const finishSignIn = pluginOnly(
  action({
    args: { id: v.string(), pasted: v.string() },
    handler: async (ctx, { id, pasted }): Promise<SubscriptionView | Failed> => {
      const signInRef = id as Id<"signIns">;
      const signIn = await ctx.runQuery(internal.signins.pending, { id: signInRef });
      if (!signIn) return fail("Cancelled", { message: "This sign-in is no longer waiting. Start again." });
      const read = readPasted(pasted);
      if ("error" in read) return fail("Unreadable", { message: read.error });
      if (read.state !== undefined && read.state !== signIn.state)
        return fail("WrongSignIn", {
          message: "That code belongs to another sign-in. Paste the one from the page this dialog opened.",
        });
      const addresses = await companyAddresses(ctx);
      let signedIn: Awaited<ReturnType<typeof exchange>>;
      try {
        signedIn = await exchange(addresses, { code: read.code, state: signIn.state }, signIn.verifier);
      } catch (error) {
        if (!(error instanceof SignInError)) throw error;
        if (error.kind === "Refused") await ctx.runMutation(internal.signins.drop, { id: signInRef });
        return fail(error.kind, { message: error.message });
      }
      const { login } = signedIn;
      const [about, found] = await Promise.all([
        profile(addresses, login.access),
        models(addresses, login.access),
      ]);
      const accountId = about.identity.accountId ?? signedIn.identity.accountId;
      if (!accountId) {
        await ctx.runMutation(internal.signins.drop, { id: signInRef });
        return fail("Refused", { message: "Claude did not say which account signed in. Start again." });
      }
      const email = about.identity.email ?? signedIn.identity.email;
      const organization = about.identity.organization ?? signedIn.identity.organization;
      const added = await ctx.runMutation(internal.signins.connect, {
        id: signInRef,
        accountId,
        ...(email !== undefined && { email }),
        ...(organization !== undefined && { organization }),
        plan: about.plan,
        models: found,
        access: login.access,
        refresh: login.refresh,
        expiresAt: login.expiresAt,
      });
      // Already added, or the subscription went away: this sign-in cannot end well, so it ends.
      // Signed in as another account while repairing: it keeps waiting for the right one.
      if (isFailure(added) && (added.kind === "AlreadyAdded" || added.kind === "Gone"))
        await ctx.runMutation(internal.signins.drop, { id: signInRef });
      return added;
    },
  }),
);
