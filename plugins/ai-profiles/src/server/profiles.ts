import {
  createFunctions,
  fail,
  type AuthContext,
  type Doc,
  type Id,
  type ModelFromSchema,
  type MutationContext,
  type QueryContext,
  v,
} from "@tokamak/sdk";
import { api as proxy, type SubscriptionView } from "plugin:agent-proxy/server";
import schema from "./schema";

/**
 * A person's profiles: named, ordered sets of their subscriptions. The window
 * builds them on the Profiles screen; a thread will run on one (TKM-266).
 *
 * Every function works for the caller only: it reads the caller's rows, and a
 * profile id of another member, of another table, or malformed gets the same
 * plain "gone" answer as a deleted one, never an error.
 *
 * A profile keeps its subscriptions as `agent-proxy` ids. When `agent-proxy`
 * no longer lists one (the person removed it, TKM-265), every reader skips it,
 * and the next write to any of the person's profiles drops it for good. The
 * removal flow can also drop it at once through `forgetSubscription`.
 */

const { query, mutation, internalQuery, internalMutation } = createFunctions(schema);
type Model = ModelFromSchema<typeof schema>;
type Row = Doc<Model, "profiles">;
type Reader = QueryContext<Model> | MutationContext<Model>;

/** What the window and the rest of this plugin learn of a profile. */
export interface ProfileView {
  readonly id: string;
  readonly name: string;
  /** Upper case, one to four characters: what the picker and the cards show. */
  readonly code: string;
  /** Subscription ids in use order, first used first; only ones `agent-proxy` still lists. */
  readonly subscriptions: readonly string[];
  readonly createdAt: number;
}

const MAX_NAME = 64;
const CODE = /^[A-Z0-9]{1,4}$/;

const ownerOf = (auth: AuthContext) => auth.user.id;

/**
 * `value` as a profile id, or null. Ids arrive as strings, and `db.get` takes
 * an id of any of this plugin's tables, so each is checked before it is read.
 */
function profileId(value: string): Id<"profiles"> | null {
  return /^(?:ai-profiles\/)?profiles:[A-Za-z0-9_-]+$/.test(value) ? (value as Id<"profiles">) : null;
}

const gone = (what: "profile" | "subscription") => fail("NotFound", { message: `That ${what} is gone.` });

/** The caller's profile with this id, or null when it is not theirs or not a profile. */
async function own(ctx: Reader, id: string): Promise<Row | null> {
  const ref = profileId(id);
  const row = ref && (await ctx.db.get(ref));
  return row && row.owner === ownerOf(ctx.auth) ? row : null;
}

/** The caller's subscriptions as `agent-proxy` lists them now, by id. */
async function subscriptionsOf(ctx: Reader): Promise<Map<string, SubscriptionView>> {
  const { subscriptions } = await ctx.use(proxy).listSubscriptions({});
  return new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
}

const rowsOf = (ctx: Reader, owner: string) =>
  ctx.db
    .query("profiles")
    .withIndex("by_owner", (q) => q.eq("owner", owner))
    .collect();

function viewOf(row: Pick<Row, "_id" | "name" | "code" | "entries" | "createdAt">, live: ReadonlyMap<string, unknown>): ProfileView {
  return {
    id: row._id,
    name: row.name,
    code: row.code,
    subscriptions: row.entries.map((entry) => entry.subscription).filter((id) => live.has(id)),
    createdAt: row.createdAt,
  };
}

/**
 * Drops entries whose subscription is gone from every one of the owner's
 * profiles, and returns the profiles as they now are. Every write starts here,
 * so a removed subscription never stays stored for long.
 */
async function prune(ctx: MutationContext<Model>, live: ReadonlyMap<string, unknown>) {
  const rows = await rowsOf(ctx, ownerOf(ctx.auth));
  const fresh = new Map<string, Row>();
  for (const row of rows) {
    const entries = row.entries.filter((entry) => live.has(entry.subscription));
    if (entries.length !== row.entries.length) await ctx.db.patch(row._id, { entries });
    fresh.set(row._id, { ...row, entries });
  }
  return fresh;
}

/** A position in a list of `length` items, from a number the window sent. */
const clamp = (value: number, length: number) => Math.min(Math.max(Math.trunc(value), 0), length);

/**
 * The profile `args.profile` after pruning, with the caller's subscriptions,
 * or the failure to return. Shared by the three changes to a profile's list.
 */
async function editable(ctx: MutationContext<Model>, profile: string) {
  const row = await own(ctx, profile);
  if (!row) return { failure: gone("profile") } as const;
  const live = await subscriptionsOf(ctx);
  const fresh = (await prune(ctx, live)).get(row._id)!;
  return { row: fresh, live, ids: fresh.entries.map((entry) => entry.subscription) } as const;
}

async function save(ctx: MutationContext<Model>, row: Row, ids: string[], live: ReadonlyMap<string, unknown>) {
  const entries = ids.map((subscription) => ({ subscription }));
  await ctx.db.patch(row._id, { entries });
  return viewOf({ ...row, entries }, live);
}

/** The caller's profiles, oldest first. */
export const list = query({
  handler: async (ctx): Promise<ProfileView[]> => {
    const live = await subscriptionsOf(ctx);
    const rows = await rowsOf(ctx, ownerOf(ctx.auth));
    return rows.sort((a, b) => a.createdAt - b.createdAt).map((row) => viewOf(row, live));
  },
});

/**
 * A new, empty profile. The code is trimmed and upper-cased; it must be one
 * to four letters or digits and not used by another of the caller's profiles
 * (checked here, in the same transaction as the write; the unique index on
 * owner and code is the backstop).
 */
export const create = mutation({
  args: { name: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const owner = ownerOf(ctx.auth);
    const name = args.name.trim().replace(/\s+/g, " ");
    const code = args.code.trim().toUpperCase();
    if (!name) return fail("Invalid", { field: "name", message: "Give the profile a name." });
    if (name.length > MAX_NAME)
      return fail("Invalid", { field: "name", message: `A name is at most ${MAX_NAME} characters.` });
    if (!CODE.test(code))
      return fail("Invalid", { field: "code", message: "A code is 1 to 4 letters or digits." });
    const taken = await ctx.db
      .query("profiles")
      .withIndex("by_owner_code", (q) => q.eq("owner", owner).eq("code", code))
      .first();
    if (taken) return fail("Taken", { field: "code", message: `You already have a profile ${code}.` });
    const live = await subscriptionsOf(ctx);
    await prune(ctx, live);
    const row = { owner, name, code, entries: [] as Row["entries"], createdAt: Date.now() };
    const id = await ctx.db.insert("profiles", row);
    return viewOf({ ...row, _id: id }, live);
  },
});

/**
 * Puts one of the caller's subscriptions into a profile at `at` (0 is first
 * used; left out, last). A subscription already in the profile is refused, so
 * a profile never lists one twice; it can be in any number of other profiles.
 */
export const add = mutation({
  args: { profile: v.string(), subscription: v.string(), at: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const found = await editable(ctx, args.profile);
    if ("failure" in found) return found.failure;
    const { row, live, ids } = found;
    if (!live.has(args.subscription)) return gone("subscription");
    if (ids.includes(args.subscription))
      return fail("AlreadyAdded", { message: `${row.code} already uses that subscription.` });
    ids.splice(clamp(args.at ?? ids.length, ids.length), 0, args.subscription);
    return save(ctx, row, ids, live);
  },
});

/** Moves a subscription inside a profile so it ends at position `to` (0 is first used). */
export const move = mutation({
  args: { profile: v.string(), subscription: v.string(), to: v.number() },
  handler: async (ctx, args) => {
    const found = await editable(ctx, args.profile);
    if ("failure" in found) return found.failure;
    const { row, live, ids } = found;
    const from = ids.indexOf(args.subscription);
    if (from < 0) return gone("subscription");
    ids.splice(from, 1);
    ids.splice(clamp(args.to, ids.length), 0, args.subscription);
    return save(ctx, row, ids, live);
  },
});

/** Takes a subscription out of one profile; it stays in Tokamak and in other profiles. */
export const remove = mutation({
  args: { profile: v.string(), subscription: v.string() },
  handler: async (ctx, args) => {
    const found = await editable(ctx, args.profile);
    if ("failure" in found) return found.failure;
    const { row, live, ids } = found;
    if (!ids.includes(args.subscription)) return gone("subscription");
    return save(
      ctx,
      row,
      ids.filter((id) => id !== args.subscription),
      live,
    );
  },
});

/**
 * Drops a subscription from every one of the caller's profiles. The flow that
 * removes a subscription from Tokamak calls this right after `agent-proxy`
 * deleted it; without the call the readers skip it anyway and the next write
 * drops it. Returns how many profiles held it.
 */
export const forgetSubscription = internalMutation({
  args: { subscription: v.string() },
  handler: async (ctx, { subscription }) => {
    let held = 0;
    for (const row of await rowsOf(ctx, ownerOf(ctx.auth))) {
      const entries = row.entries.filter((entry) => entry.subscription !== subscription);
      if (entries.length === row.entries.length) continue;
      held++;
      await ctx.db.patch(row._id, { entries });
    }
    return held;
  },
});

/**
 * What a turn on this profile may use (TKM-266): the caller's profile with
 * its subscriptions in use order, only the enabled ones that `agent-proxy`
 * still lists. The first is used first. Signed-out and limited accounts are
 * `agent-proxy`'s to skip when it picks one.
 */
export const inUseOrder = internalQuery({
  args: { profile: v.string() },
  handler: async (ctx, args) => {
    const row = await own(ctx, args.profile);
    if (!row) return gone("profile");
    const live = await subscriptionsOf(ctx);
    const subscriptions = row.entries
      .map((entry) => live.get(entry.subscription))
      .filter((subscription): subscription is SubscriptionView => !!subscription?.enabled);
    return { id: row._id as string, name: row.name, code: row.code, subscriptions };
  },
});
