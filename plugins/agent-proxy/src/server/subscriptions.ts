import { fail, pluginOnly, v, type Id } from "@tokamak/sdk";
import { internal } from "./_generated/internal";
import {
  action,
  mutation,
  ownerOf,
  query,
  viewOf,
  type SignInView,
  type SubscriptionView,
} from "./_functions";

/**
 * What other plugins (today `ai-profiles`, for its screen) may read and
 * change of a person's subscriptions. All plugin-only, all for the caller:
 * another member of the same server never sees them.
 */

/** The caller's subscriptions, oldest first, and their sign-ins that have not ended. */
export const listSubscriptions = pluginOnly(
  query({
    handler: async (ctx): Promise<{ subscriptions: SubscriptionView[]; signIns: SignInView[] }> => {
      const owner = ownerOf(ctx.auth);
      const subscriptions = await ctx.db
        .query("subscriptions")
        .withIndex("by_owner", (q) => q.eq("owner", owner))
        .collect();
      const accounts = await ctx.db
        .query("accounts")
        .withIndex("by_owner", (q) => q.eq("owner", owner))
        .collect();
      const signIns = await ctx.db
        .query("signIns")
        .withIndex("by_owner", (q) => q.eq("owner", owner))
        .collect();
      return {
        subscriptions: subscriptions
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((subscription) =>
            viewOf(
              subscription,
              accounts.filter((account) => account.subscription === subscription._id),
            ),
          ),
        signIns: signIns
          .sort((a, b) => a.startedAt - b.startedAt)
          .map(({ _id, company, method, link, startedAt, repair }) => ({
            id: _id,
            company,
            method,
            link,
            startedAt,
            ...(repair !== undefined && { repair }),
          })),
      };
    },
  }),
);

const MAX_LABEL = 64;

/** The person's own name for a subscription, such as "Personal"; empty clears it. */
export const setLabel = pluginOnly(
  mutation({
    args: { id: v.string(), label: v.string() },
    handler: async (ctx, { id, label }) => {
      const subscription = await ctx.db.get(id as Id<"subscriptions">);
      if (!subscription || subscription.owner !== ownerOf(ctx.auth))
        return fail("Gone", { message: "That subscription is gone." });
      const text = label.trim().replace(/\s+/g, " ");
      if (text.length > MAX_LABEL)
        return fail("TooLong", { message: `A label is at most ${MAX_LABEL} characters.` });
      await ctx.db.patch(subscription._id, { label: text });
      return null;
    },
  }),
);

/**
 * Switched off, a subscription stays with its login, and profiles skip it
 * (once the proxy exists, TKM-263) until it is switched on again.
 */
export const setEnabled = pluginOnly(
  mutation({
    args: { id: v.string(), enabled: v.boolean() },
    handler: async (ctx, { id, enabled }) => {
      const subscription = await ctx.db.get(id as Id<"subscriptions">);
      if (!subscription || subscription.owner !== ownerOf(ctx.auth))
        return fail("Gone", { message: "That subscription is gone." });
      await ctx.db.patch(subscription._id, { enabled });
      return null;
    },
  }),
);

/**
 * Renews every one of the caller's logins that runs out soon, without the
 * person. There is no timer a plugin's server code can run that may use the
 * network (the `maintenance` entry is a mutation), so the Profiles screen
 * asks for this while it is open, and the proxy will renew each login before
 * it uses it. A login Claude will not renew turns its card "Signed out".
 */
export const renewLogins = pluginOnly(
  action({
    handler: async (ctx): Promise<{ renewed: number; signedOut: number }> => {
      const due = await ctx.runQuery(internal.logins.due, {});
      let renewed = 0;
      let signedOut = 0;
      for (const { account } of due) {
        const login = await ctx.runAction(internal.logins.fresh, { account });
        if (login) renewed++;
        else if (!(await ctx.runQuery(internal.logins.read, { account }))) signedOut++;
      }
      return { renewed, signedOut };
    },
  }),
);
