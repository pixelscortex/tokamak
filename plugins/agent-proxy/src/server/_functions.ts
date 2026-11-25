import {
  createFunctions,
  fail,
  type AuthContext,
  type Doc,
  type Id,
  type ModelFromSchema,
} from "@tokamak/sdk";
import schema from "./schema";

export const { query, mutation, action, internalQuery, internalMutation, internalAction } =
  createFunctions(schema);
export type Model = ModelFromSchema<typeof schema>;

/**
 * The member a row belongs to. Every function reads and writes only the
 * caller's rows; nested calls keep the caller, so another plugin calling in
 * on someone's behalf sees that person's subscriptions and nobody else's.
 */
export const ownerOf = (auth: AuthContext) => auth.user.id;

/** Renew a login this long before it runs out, so a turn never starts on a dying one. */
export const RENEW_BEFORE_MS = 5 * 60_000;

/**
 * A sign-in nobody finished within this time is over: its link and verifier
 * are no longer used, and it is deleted by the next call that changes sign-ins.
 * (Kept as one plain number so the sign-in test can build a copy with a short one.)
 */
export const SIGN_IN_TTL_MS = 900000;

export const isExpired = (signIn: { startedAt: number }, now: number) =>
  now - signIn.startedAt >= SIGN_IN_TTL_MS;

type Table = "subscriptions" | "accounts" | "signIns";

/**
 * `value` as an id of `table`, or null. The window and other plugins pass ids
 * as strings, and `db.get` accepts an id of any of this plugin's tables, so
 * every function that takes an id checks its table before reading it: a
 * subscription id must never cancel a sign-in, nor a sign-in id get a label.
 */
export function idIn<T extends Table>(table: T, value: string): Id<T> | null {
  return new RegExp(`^(?:agent-proxy/)?${table}:[A-Za-z0-9_-]+$`).test(value) ? (value as Id<T>) : null;
}

/** The plain answer for an id that is malformed, of another table, gone, or another member's. */
export const notFound = (what: "subscription" | "sign-in") =>
  fail("NotFound", { message: `That ${what} is gone.` });

/** What the window and other plugins may learn of a subscription: never the login. */
export interface SubscriptionView {
  readonly id: string;
  readonly company: "anthropic";
  readonly method: "subscription";
  readonly label: string;
  readonly plan: string;
  readonly enabled: boolean;
  /** Signed out when any of its accounts is; the card then offers "Sign in". */
  readonly status: "ok" | "signed-out";
  readonly reason?: string;
  readonly accounts: readonly { email?: string; organization?: string; status: "ok" | "signed-out" }[];
  readonly models: readonly { id: string; name: string }[];
  readonly lastUsedAt?: number;
  readonly createdAt: number;
}

/** A sign-in that has not ended, as the "Awaiting sign-in" card and the dialog show it. */
export interface SignInView {
  readonly id: string;
  readonly company: "anthropic";
  readonly method: "subscription";
  /** The company's page; holds the challenge and `state`, never the verifier. */
  readonly link: string;
  readonly startedAt: number;
  /** The subscription it repairs in place. */
  readonly repair?: string;
  /** Older than 15 minutes: it can no longer finish; the person starts again. */
  readonly expired: boolean;
}

export function signInViewOf(row: Doc<Model, "signIns">, now: number): SignInView {
  return {
    id: row._id,
    company: row.company,
    method: row.method,
    link: row.link,
    startedAt: row.startedAt,
    ...(row.repair !== undefined && { repair: row.repair }),
    expired: isExpired(row, now),
  };
}

export function viewOf(
  subscription: Doc<Model, "subscriptions">,
  accounts: readonly Doc<Model, "accounts">[],
): SubscriptionView {
  const out = accounts.find((account) => account.status === "signed-out");
  return {
    id: subscription._id,
    company: subscription.company,
    method: subscription.method,
    label: subscription.label,
    plan: subscription.plan,
    enabled: subscription.enabled,
    status: out ? "signed-out" : "ok",
    ...(out?.reason !== undefined && { reason: out.reason }),
    accounts: accounts.map(({ email, organization, status }) => ({
      ...(email !== undefined && { email }),
      ...(organization !== undefined && { organization }),
      status,
    })),
    models: subscription.models,
    ...(subscription.lastUsedAt !== undefined && { lastUsedAt: subscription.lastUsedAt }),
    createdAt: subscription.createdAt,
  };
}
