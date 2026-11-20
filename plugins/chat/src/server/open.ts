import {
  createApi,
  functionName,
  v,
  type ActionContext,
  type DatabaseWriter,
  type Doc,
  type FunctionReference,
  type Id,
} from "@tokamak/sdk";
import { action, mutation, query, thread, type Model } from "./_functions";
import { api } from "./_generated/api";
import { folderSetting } from "./backends/backend";
import { configureBackend, listBackends } from "./backends/backends";
import type { BackendApi } from "../shared/backends";

const lifetime = 5 * 60_000;
type Thread = Doc<Model, "threads">;
type OpenResult = {
  threadId: Id<"threads">;
  requestId: Id<"openRequests">;
  created: boolean;
  agent: { plugin: string; backendId: string } | null;
  folderRecorded: boolean;
  local: boolean;
};

const foldersApi = createApi<{
  backend: {
    canonicalFolders: FunctionReference<"action", { folders: string[] }, (string | null)[]>;
  };
}>("acp");

function folderOf(thread: Thread) {
  return thread.backend ? folderSetting(thread.backend.settings) : thread.starterFolder;
}

async function matchFolder(ctx: ActionContext, folder: string) {
  const candidates = (await ctx.runQuery(api.threads.list, {})).flatMap((item: Thread) => {
    const path = folderOf(item);
    return path ? [{ item, path }] : [];
  });
  if (candidates.some(({ path }) => path !== folder)) {
    const providers = await ctx.providers<BackendApi>("chat.backend");
    if (providers.some((provider) => provider.backend.describe[functionName] === "acp/backend:describe")) {
      const [real, ...paths] = await ctx.use(foldersApi).backend.canonicalFolders({
        folders: [folder, ...candidates.map(({ path }) => path)],
      });
      if (real) return candidates.find((_, i) => paths[i] === real)?.item;
    }
  }
  return candidates.find(({ path }) => path === folder)?.item;
}

export const request = action({
  args: { folder: v.optional(v.string()), alwaysNew: v.optional(v.boolean()) },
  handler: async (ctx, { folder, alwaysNew }): Promise<OpenResult> => {
    const local = ctx.user.id === "local";
    if (!local && (folder !== undefined || alwaysNew !== undefined))
      throw new Error("A shared server does not accept a working folder");
    if (local && !folder) throw new Error("A working folder is required");

    const previous = folder && !alwaysNew ? await matchFolder(ctx, folder) : undefined;
    let threadId = previous?._id;
    if (!threadId) {
      const first = folder ? (await listBackends(ctx))[0] : undefined;
      if (first && folder) {
        const settings = await configureBackend(ctx, {
          plugin: first.plugin,
          backendId: first.id,
          settings: { cwd: folder },
        });
        if (folderSetting(settings) !== folder)
          throw new Error("The agent would use a different folder; no thread was created");
        threadId = await ctx.runMutation(api.threads.insert, {
          backend: { kind: "plugin", plugin: first.plugin, backendId: first.id, settings },
        });
      } else {
        threadId = await ctx.runMutation(api.threads.insert, folder ? { starterFolder: folder } : {});
      }
    }

    const { requestId, agent } = await ctx.runMutation(api.open.record, { threadId });
    return { requestId, threadId, created: !previous, agent, folderRecorded: local, local };
  },
});

export const record = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const { db, user } = ctx;
    const { backend } = await thread(db, threadId);
    const pending = await db
      .query("openRequests")
      .withIndex("by_userId", (q) => q.eq("userId", user.id))
      .first();
    if (pending) await db.delete(pending._id);
    const requestId = await db.insert("openRequests", {
      userId: user.id,
      threadId,
      expiresAt: Date.now() + lifetime,
    });
    const agent =
      user.id === "local" && backend ? { plugin: backend.plugin, backendId: backend.backendId } : null;
    return { requestId, agent };
  },
});

export const latest = query({
  handler: async ({ db, user }) => {
    const request = await db
      .query("openRequests")
      .withIndex("by_userId", (q) => q.eq("userId", user.id))
      .first();
    return request && request.expiresAt > Date.now() && (await db.get(request.threadId)) ? request : null;
  },
});

export const status = query({
  args: { requestId: v.id("openRequests") },
  handler: async ({ db, user }, { requestId }) => {
    const request = await db.get(requestId);
    if (request?.userId === user.id && request.expiresAt > Date.now()) return "pending" as const;
    const receipt = await db
      .query("openReceipts")
      .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
      .first();
    return receipt?.userId === user.id && receipt.expiresAt > Date.now()
      ? ("acknowledged" as const)
      : ("replaced" as const);
  },
});

export const shown = mutation({
  args: { requestId: v.id("openRequests") },
  handler: async ({ db, user }, { requestId }) => {
    const request = await db.get(requestId);
    if (request?.userId === user.id) {
      await db.delete(requestId);
      if (request.expiresAt > Date.now())
        await db.insert("openReceipts", { userId: user.id, requestId, expiresAt: request.expiresAt });
    }
    return null;
  },
});

export async function pruneOpenRequests(db: DatabaseWriter<Model>) {
  const now = Date.now();
  for (const table of ["openRequests", "openReceipts"] as const) {
    for (const row of await db
      .query(table)
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(32))
      await db.delete(row._id);
  }
}
