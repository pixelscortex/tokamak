import { action, mutation, query, v } from "@tokamak/sdk";
import { api as proxy } from "plugin:agent-proxy/server";

/**
 * The Profiles screen's subscriptions. `agent-proxy` owns them and their
 * logins; these pass the window's calls on to its plugin-only functions,
 * which answer for the calling member only and never with a login. This
 * plugin stores nothing about subscriptions itself.
 */

/** The person's subscriptions and their sign-ins that have not ended. */
export const list = query({
  handler: (ctx) => ctx.use(proxy).listSubscriptions({}),
});

/** Starts a sign-in and returns the company's page; `repair` signs a subscription in again. */
export const startSignIn = action({
  args: {
    company: v.literal("anthropic"),
    method: v.literal("subscription"),
    repair: v.optional(v.string()),
  },
  handler: (ctx, args) => ctx.use(proxy).startSignIn(args),
});

/** Finishes a sign-in with the link or code the company's page ended on. */
export const finishSignIn = action({
  args: { id: v.string(), pasted: v.string() },
  handler: (ctx, args) => ctx.use(proxy).finishSignIn(args),
});

/** Stops waiting for a sign-in; nothing is left behind. */
export const cancelSignIn = mutation({
  args: { id: v.string() },
  handler: (ctx, args) => ctx.use(proxy).cancelSignIn(args),
});

export const setLabel = mutation({
  args: { id: v.string(), label: v.string() },
  handler: (ctx, args) => ctx.use(proxy).setLabel(args),
});

export const setEnabled = mutation({
  args: { id: v.string(), enabled: v.boolean() },
  handler: (ctx, args) => ctx.use(proxy).setEnabled(args),
});

/** Renews logins that run out soon; the screen asks while it is open. */
export const renew = action({
  handler: (ctx) => ctx.use(proxy).renewLogins({}),
});
