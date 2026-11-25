import { fail, isFailure, pluginOnly, v, type Id } from "@tokamak/sdk";
import type {} from "@tokamak/sdk/web";
import { internal } from "./_generated/internal";
import {
  action,
  idIn,
  internalMutation,
  internalQuery,
  isExpired,
  mutation,
  notFound,
  ownerOf,
  signInViewOf,
  viewOf,
  type SignInView,
  type SubscriptionView,
} from "./_functions";
import { companyAddresses } from "./addresses";
import { companies } from "./companies";
import { SignInError, type SignedIn } from "./company";
import { randomToken } from "./pkce";
import { company } from "./schema";

/**
 * Adding a subscription, or signing one in again. The server makes the link
 * and keeps the PKCE verifier; the person signs in on the company's page and
 * pastes back the address the browser ended on; the server trades that for
 * the login. Everything that differs between companies is in their own
 * module (`companies.ts`); nothing here names one. The sign-in is a row, so it lives on when the dialog closes and can
 * be cancelled from the "Awaiting sign-in" card.
 *
 * A wrong paste never ends it: the same link can be opened again for a new
 * code, and the verifier stays. It ends when it is finished, cancelled,
 * replaced by a new start for the same target, or 15 minutes old. Finishing
 * is claimed on the row, so a second paste while one is being exchanged gets
 * "already finishing" and changes nothing.
 *
 * These are plugin-only: other plugins reach them as the calling member, and
 * no result carries the login, the verifier or anything read from them.
 */

/** How long one finish holds its claim: longer than the exchange and the reads after it. */
const FINISH_CLAIM_MS = 90_000;
const EXPIRED = "This sign-in expired after 15 minutes. Start again.";

type Failed = { failed: true; kind: string; data: { message: string } };

/** One "Awaiting sign-in" per target: starting again replaces the unfinished one. */
export const begin = internalMutation({
  args: {
    owner: v.string(),
    company,
    verifier: v.string(),
    state: v.string(),
    link: v.string(),
    repair: v.optional(v.id("subscriptions")),
  },
  handler: async (ctx, { owner, company, verifier, state, link, repair }) => {
    if (repair) {
      const subscription = await ctx.db.get(repair);
      // A subscription is signed in again only with its own company.
      if (!subscription || subscription.owner !== owner || subscription.company !== company)
        return notFound("subscription");
    }
    const now = Date.now();
    const open = await ctx.db
      .query("signIns")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .collect();
    // The same target is replaced; expired ones of any target go too.
    for (const row of open) if (row.repair === repair || isExpired(row, now)) await ctx.db.delete(row._id);
    const id = await ctx.db.insert("signIns", {
      owner,
      company,
      method: "subscription",
      verifier,
      state,
      link,
      startedAt: now,
      ...(repair && { repair }),
    });
    return signInViewOf((await ctx.db.get(id))!, now);
  },
});

/** Makes the sign-in link: a Claude or ChatGPT subscription (API keys come later). */
export const startSignIn = pluginOnly(
  action({
    args: {
      company,
      method: v.literal("subscription"),
      /** A signed-out subscription to repair in place instead of adding a new one. */
      repair: v.optional(v.string()),
    },
    handler: async (ctx, { company, repair }): Promise<SignInView | Failed> => {
      let target: Id<"subscriptions"> | undefined;
      if (repair !== undefined) {
        const ref = idIn("subscriptions", repair);
        if (!ref) return notFound("subscription");
        target = ref;
      }
      const verifier = randomToken();
      const state = randomToken();
      const link = companies[company].link(await companyAddresses(ctx), verifier, state);
      return ctx.runMutation(internal.signins.begin, {
        owner: ownerOf(ctx.auth),
        company,
        verifier,
        state,
        link,
        ...(target && { repair: target }),
      });
    },
  }),
);

/**
 * Claims a waiting sign-in for one finish and returns it with its verifier;
 * deletes it when it has expired. Internal, for `finishSignIn` only.
 */
export const claimFinish = internalMutation({
  args: { owner: v.string(), id: v.id("signIns") },
  handler: async (ctx, { owner, id }) => {
    const row = await ctx.db.get(id);
    if (!row || row.owner !== owner)
      return fail("Cancelled", { message: "This sign-in is no longer waiting. Start again." });
    const now = Date.now();
    // Not a `fail`: a mutation that fails rolls back, and the delete must stay.
    if (isExpired(row, now)) {
      await ctx.db.delete(id);
      return { expired: true as const };
    }
    if ((row.finishingUntil ?? 0) > now)
      return fail("Busy", { message: "This sign-in is already finishing. Wait a moment." });
    await ctx.db.patch(id, { finishingUntil: now + FINISH_CLAIM_MS });
    return { expired: false as const, company: row.company, verifier: row.verifier, state: row.state };
  },
});

/** Lets go of the claim after a failed finish; the sign-in keeps waiting. */
export const release = internalMutation({
  args: { owner: v.string(), id: v.id("signIns") },
  handler: async (ctx, { owner, id }) => {
    const row = await ctx.db.get(id);
    if (!row || row.owner !== owner) return false;
    const { finishingUntil: _claim, _id, _creationTime, ...fields } = row;
    await ctx.db.replace(_id, fields);
    return true;
  },
});

/**
 * Which company the member's sign-in is with, so the paste can be read its
 * way, and whether it has expired; null when it is gone or another member's.
 */
export const pending = internalQuery({
  args: { owner: v.string(), id: v.id("signIns") },
  handler: async (ctx, { owner, id }) => {
    const row = await ctx.db.get(id);
    return row && row.owner === owner ? { company: row.company, expired: isExpired(row, Date.now()) } : null;
  },
});

/** Ends a sign-in without a subscription; false when it had already ended. */
export const drop = internalMutation({
  args: { owner: v.string(), id: v.id("signIns") },
  handler: async (ctx, { owner, id }) => {
    const row = await ctx.db.get(id);
    if (!row || row.owner !== owner) return false;
    await ctx.db.delete(id);
    return true;
  },
});

/** Stops waiting. Nothing was stored for it, so nothing else is removed. */
export const cancelSignIn = pluginOnly(
  mutation({
    args: { id: v.string() },
    handler: async (ctx, { id }) => {
      const ref = idIn("signIns", id);
      const row = ref && (await ctx.db.get(ref));
      if (!row || row.owner !== ownerOf(ctx.auth)) return notFound("sign-in");
      await ctx.db.delete(row._id);
      return null;
    },
  }),
);

const model = v.object({ id: v.string(), name: v.string() });

/**
 * Stores what the sign-in brought, in one transaction with ending it. The
 * sign-in must still be waiting: a cancel that came while the company answered wins,
 * and the login is dropped.
 */
export const connect = internalMutation({
  args: {
    owner: v.string(),
    id: v.id("signIns"),
    accountId: v.string(),
    email: v.optional(v.string()),
    organization: v.optional(v.string()),
    plan: v.string(),
    models: v.array(model),
    access: v.string(),
    refresh: v.string(),
    expiresAt: v.number(),
    idToken: v.optional(v.string()),
  },
  handler: async (ctx, { owner, id, access, refresh, expiresAt, idToken, ...found }) => {
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
        company: signIn.company,
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
    await ctx.db.insert("logins", {
      owner,
      account: accountId,
      access,
      refresh,
      expiresAt,
      ...(idToken !== undefined && { idToken }),
    });
    const subscription = (await ctx.db.get(subscriptionId))!;
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_subscription", (q) => q.eq("subscription", subscriptionId))
      .collect();
    return viewOf(subscription, accounts);
  },
});

/**
 * Finishes a sign-in with what the person pasted: the address the browser
 * ended on, a `code#state`, or the code alone. A paste that cannot be read,
 * belongs to another sign-in, or that the company refuses leaves the sign-in
 * waiting with its claim released, so the person can paste again or open the
 * page again for a new code. Already added, or the repaired subscription
 * gone, ends it.
 */
export const finishSignIn = pluginOnly(
  action({
    args: { id: v.string(), pasted: v.string() },
    handler: async (ctx, { id, pasted }): Promise<SubscriptionView | Failed> => {
      const ref = idIn("signIns", id);
      if (!ref) return notFound("sign-in");
      const owner = ownerOf(ctx.auth);
      const args = { owner, id: ref };
      /** Ends this finish: the sign-in keeps waiting (claim released) or is over. */
      const settle = (end: boolean) =>
        end ? ctx.runMutation(internal.signins.drop, args) : ctx.runMutation(internal.signins.release, args);
      const waiting = await ctx.runQuery(internal.signins.pending, args);
      if (!waiting) return fail("Cancelled", { message: "This sign-in is no longer waiting. Start again." });
      const company = companies[waiting.company];
      const read = company.readPasted(pasted);
      // A paste that cannot be read changes nothing, not even the claim.
      if ("error" in read)
        return waiting.expired
          ? fail("Cancelled", { message: "This sign-in is no longer waiting. Start again." })
          : fail("Unreadable", { message: read.error });
      const claimed = await ctx.runMutation(internal.signins.claimFinish, args);
      if (isFailure(claimed)) return claimed;
      if (claimed.expired) return fail("Expired", { message: EXPIRED });
      if (read.state !== undefined && read.state !== claimed.state) {
        await settle(false);
        return fail("WrongSignIn", {
          message: "That address belongs to another sign-in. Paste the one from the page this dialog opened.",
        });
      }
      const addresses = await companyAddresses(ctx);
      let signedIn: SignedIn;
      try {
        signedIn = await company.exchange(
          addresses,
          { code: read.code, state: claimed.state },
          claimed.verifier,
        );
      } catch (error) {
        await settle(false);
        if (!(error instanceof SignInError)) throw error;
        return fail(error.kind, { message: error.message });
      }
      const { login } = signedIn;
      const about = await company.details(addresses, signedIn);
      const accountId = about.identity.accountId ?? signedIn.identity.accountId;
      if (!accountId) {
        await settle(false);
        return fail("Refused", {
          message: `${company.name} did not say which account signed in. Try again.`,
        });
      }
      const email = about.identity.email ?? signedIn.identity.email;
      const organization = about.identity.organization ?? signedIn.identity.organization;
      const added = await ctx.runMutation(internal.signins.connect, {
        ...args,
        accountId,
        ...(email !== undefined && { email }),
        ...(organization !== undefined && { organization }),
        plan: about.plan,
        models: about.models,
        access: login.access,
        refresh: login.refresh,
        expiresAt: login.expiresAt,
        ...(login.idToken !== undefined && { idToken: login.idToken }),
      });
      // `connect` rolls back on failure, so the sign-in is still there with its claim.
      if (isFailure(added)) await settle(added.kind === "AlreadyAdded" || added.kind === "Gone");
      return added;
    },
  }),
);
