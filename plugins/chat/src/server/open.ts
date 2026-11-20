import { v, type Doc, type Id } from "@tokamak/sdk";
import { DEFAULT_TITLE, action, mutation, query, type Model } from "./_functions";
import { api } from "./_generated/api";
import { backend } from "./backends/backend";
import { configureBackend, listBackends } from "./backends/backends";

type Thread = Doc<Model, "threads">;
type OpenResult = {
  threadId: Id<"threads">;
  requestId: Id<"openRequests">;
  created: boolean;
  agent: { plugin: string; backendId: string } | null;
  folderRecorded: boolean;
  local: boolean;
};

function folderOf(thread: Thread) {
  if (!thread.backend) return thread.starterFolder;
  const settings = thread.backend.settings;
  if (
    settings &&
    typeof settings === "object" &&
    !Array.isArray(settings) &&
    typeof settings.cwd === "string"
  )
    return settings.cwd;
}

export const request = action({
  args: { folder: v.string(), alwaysNew: v.boolean() },
  handler: async (ctx, args): Promise<OpenResult> => {
    if (!args.alwaysNew) {
      const existing = await ctx.runMutation(api.open.record, { ...args, createIfMissing: false });
      if (existing) return existing;
    }
    const first = ctx.user.id === "local" ? (await listBackends(ctx))[0] : undefined;
    const selected = first && {
      kind: "plugin" as const,
      plugin: first.plugin,
      backendId: first.id,
      settings: await configureBackend(ctx, {
        plugin: first.plugin,
        backendId: first.id,
        settings: { cwd: args.folder },
      }),
    };
    const result = await ctx.runMutation(api.open.record, {
      ...args,
      createIfMissing: true,
      ...(selected ? { backend: selected } : {}),
    });
    if (!result) throw new Error("Could not create a thread");
    return result;
  },
});

export const record = mutation({
  args: {
    folder: v.string(),
    alwaysNew: v.boolean(),
    createIfMissing: v.boolean(),
    backend: v.optional(backend),
  },
  handler: async ({ db, user }, args): Promise<OpenResult | null> => {
    const previous = args.alwaysNew
      ? undefined
      : (await db.query("threads").withIndex("by_updatedAt").order("desc").collect()).find(
          (item) => folderOf(item) === args.folder,
        );
    if (!previous && !args.createIfMissing) return null;
    const now = Date.now();
    const local = user.id === "local";
    const selected = local ? (previous ? previous.backend : args.backend) : undefined;
    const threadId =
      previous?._id ??
      (await db.insert("threads", {
        title: DEFAULT_TITLE,
        createdAt: now,
        updatedAt: now,
        ...(selected ? { backend: selected } : local ? { starterFolder: args.folder } : {}),
      }));
    const pending = await db
      .query("openRequests")
      .withIndex("by_userId", (q) => q.eq("userId", user.id))
      .first();
    if (pending) await db.delete(pending._id);
    const requestId = await db.insert("openRequests", { userId: user.id, threadId, shown: false });
    return {
      threadId,
      requestId,
      created: !previous,
      agent: selected ? { plugin: selected.plugin, backendId: selected.backendId } : null,
      folderRecorded: Boolean(previous || local),
      local,
    };
  },
});

export const latest = query({
  handler: async ({ db, user }) => {
    const request = await db
      .query("openRequests")
      .withIndex("by_userId", (q) => q.eq("userId", user.id))
      .first();
    return request && (await db.get(request.threadId)) ? request : null;
  },
});

export const shown = mutation({
  args: { requestId: v.id("openRequests") },
  handler: async ({ db, user }, { requestId }) => {
    const request = await db.get(requestId);
    if (request?.userId === user.id && !request.shown) await db.patch(requestId, { shown: true });
    return null;
  },
});
