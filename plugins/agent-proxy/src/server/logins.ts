import { v, type Id } from "@tokamak/sdk";
import type {} from "@tokamak/sdk/web";
import { internal } from "./_generated/internal";
import { RENEW_BEFORE_MS, internalAction, internalMutation, internalQuery, ownerOf } from "./_functions";
import { companyAddresses } from "./addresses";
import { renew } from "./claude";

/**
 * The stored logins. Everything here is internal: no window and no other
 * plugin can call it, and nothing it returns leaves this plugin. The one
 * way to a usable login is `fresh`, which renews it first when it is about
 * to run out; the proxy (TKM-263) will call it before every request.
 */

const accountId = v.id("accounts");
const REFUSED = "Claude would not renew the login. Sign in again.";

/** The caller's login for `account`, or null when it has none or it is someone else's. */
export const read = internalQuery({
  args: { account: accountId },
  handler: async (ctx, { account }) => {
    const row = await ctx.db
      .query("logins")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    return row && row.owner === ownerOf(ctx.auth) ? row : null;
  },
});

/** The caller's accounts whose login runs out within the renewal margin, soonest first. */
export const due = internalQuery({
  handler: async (ctx) => {
    const owner = ownerOf(ctx.auth);
    const soon = Date.now() + RENEW_BEFORE_MS;
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .collect();
    const due: { account: Id<"accounts">; expiresAt: number }[] = [];
    for (const account of accounts) {
      if (account.status !== "ok") continue;
      const login = await ctx.db
        .query("logins")
        .withIndex("by_account", (q) => q.eq("account", account._id))
        .first();
      if (login && login.expiresAt <= soon) due.push({ account: account._id, expiresAt: login.expiresAt });
    }
    return due.sort((a, b) => a.expiresAt - b.expiresAt);
  },
});

/**
 * Keeps a renewed login, unless the account changed meanwhile (signed out or
 * signed in again): `refresh` is the token the renewal was made with.
 */
export const renewed = internalMutation({
  args: {
    account: accountId,
    refresh: v.string(),
    access: v.string(),
    next: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, { account, refresh, access, next, expiresAt }) => {
    const row = await ctx.db
      .query("logins")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (!row || row.owner !== ownerOf(ctx.auth) || row.refresh !== refresh) return false;
    await ctx.db.patch(row._id, { access, refresh: next, expiresAt });
    return true;
  },
});

/** Claude will not renew it: the login is deleted and the account shows "Signed out". */
export const refused = internalMutation({
  args: { account: accountId, refresh: v.string() },
  handler: async (ctx, { account, refresh }) => {
    const row = await ctx.db
      .query("logins")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (!row || row.owner !== ownerOf(ctx.auth) || row.refresh !== refresh) return false;
    await ctx.db.delete(row._id);
    await ctx.db.patch(account, { status: "signed-out", reason: REFUSED });
    return true;
  },
});

/**
 * A login that is good for at least the renewal margin, renewed first when
 * needed; null when the account is signed out or Claude could not be asked.
 * Returns the access token: only this plugin's own server code may call it.
 */
export const fresh = internalAction({
  args: { account: accountId },
  handler: async (ctx, { account }): Promise<{ access: string; expiresAt: number } | null> => {
    const login = await ctx.runQuery(internal.logins.read, { account });
    if (!login) return null;
    if (login.expiresAt > Date.now() + RENEW_BEFORE_MS)
      return { access: login.access, expiresAt: login.expiresAt };
    const next = await renew(await companyAddresses(ctx), login.refresh);
    // Not reachable now: an unexpired login is still usable, an expired one is not.
    if (!next)
      return login.expiresAt > Date.now() ? { access: login.access, expiresAt: login.expiresAt } : null;
    // Both writes check the refresh token the renewal used. Claude rotates it, so a
    // second renewal racing the first is refused; that must not sign the account out.
    const kept =
      next === "refused"
        ? await ctx.runMutation(internal.logins.refused, { account, refresh: login.refresh })
        : await ctx.runMutation(internal.logins.renewed, {
            account,
            refresh: login.refresh,
            access: next.access,
            next: next.refresh,
            expiresAt: next.expiresAt,
          });
    if (kept) return next === "refused" ? null : { access: next.access, expiresAt: next.expiresAt };
    // Another call renewed it first, or it was signed in again: use what is stored now.
    const now = await ctx.runQuery(internal.logins.read, { account });
    return now && now.expiresAt > Date.now() ? { access: now.access, expiresAt: now.expiresAt } : null;
  },
});
