import { defineSchema, defineTable, v } from "@tokamak/sdk";

/**
 * Every row carries `owner`, the member who added it: a subscription is one
 * person's, and every function reads and writes only the caller's rows.
 *
 * The secrets live in two tables of their own, `logins` and `signIns`, which
 * only this plugin's internal functions read. Nothing that leaves the plugin
 * is built from them. There is no secret store in the SDK yet (TKM-292), so
 * whoever can read the server's database can read them.
 */
export default defineSchema({
  /** What a person added: one company's subscription, under their own label. */
  subscriptions: defineTable({
    owner: v.string(),
    company: v.literal("anthropic"),
    method: v.literal("subscription"),
    label: v.string(),
    /** "Max", "Pro", "Team", "Enterprise", or "Free" when the company named none. */
    plan: v.string(),
    enabled: v.boolean(),
    models: v.array(v.object({ id: v.string(), name: v.string() })),
    /** When a turn last went through it; none until the proxy (TKM-263) uses it. */
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_owner", ["owner"]),

  /** One login at the company: a team plan can hold several under one subscription. */
  accounts: defineTable({
    owner: v.string(),
    subscription: v.id("subscriptions"),
    /** The company's own id for the account, so the same login is never added twice. */
    accountId: v.string(),
    email: v.optional(v.string()),
    organization: v.optional(v.string()),
    status: v.union(v.literal("ok"), v.literal("signed-out")),
    /** Why the account is signed out, in the person's words. */
    reason: v.optional(v.string()),
  })
    .index("by_owner", ["owner"])
    .index("by_subscription", ["subscription"])
    .index("by_owner_account", ["owner", "accountId"]),

  /** The login itself. Only internal functions read this table. */
  logins: defineTable({
    owner: v.string(),
    account: v.id("accounts"),
    access: v.string(),
    refresh: v.string(),
    /** Milliseconds since the epoch. */
    expiresAt: v.number(),
  }).index("by_account", ["account"]),

  /**
   * A sign-in that has started and not ended. It lives on when the dialog
   * closes, so the screen can show "Awaiting sign-in" and the person can
   * still paste. `verifier` and `state` stay here; the window gets the link.
   */
  signIns: defineTable({
    owner: v.string(),
    company: v.literal("anthropic"),
    method: v.literal("subscription"),
    verifier: v.string(),
    state: v.string(),
    link: v.string(),
    startedAt: v.number(),
    /** The subscription this sign-in repairs in place; absent for a new one. */
    repair: v.optional(v.id("subscriptions")),
  }).index("by_owner", ["owner"]),
});
