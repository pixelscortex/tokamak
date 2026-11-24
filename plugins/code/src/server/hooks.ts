import { fail, local, provide, type Id, type LocalContext } from "@tokamak/sdk";
import * as ai from "plugin:ai/contracts";
import { threadDeletedLocal, type DeletedThread } from "plugin:chat/contracts";
import { api as chat } from "plugin:chat/server";
import { pruneSnapshots, trackSnapshots } from "../local/snapshots";
import { BEFORE_NOT_SAVED } from "../shared/text";
import { AFTER_SNAPSHOT_WARNING, beforeSnapshot, deleteSnapshots, repository, snapshot } from "../local/git";

export const snapshotHooks = provide(
  ai.turnHooks,
  {
    afterTimeoutNotice: AFTER_SNAPSHOT_WARNING,
    before: local({
      handler: async (ctx, turn: ai.TurnInfo) => {
        try {
          const repo = await repository(ctx, turn.folder, turn.signal);
          if (!repo) return;
          const target = { ...repo, ...turn };
          await trackSnapshots(ctx, target);
          await snapshot(ctx, target, "before");
          if (await cleanedIfDeleted(ctx, target))
            return fail("ThreadDeleted", { reason: "The thread was deleted before the agent could start." });
        } catch (cause) {
          // A turn reason is stored by ai. Keep repository paths and Git output local.
          const step = cause instanceof Error && /^Git could not ([a-z-]+):/.exec(cause.message)?.[1];
          return fail("NotSaved", {
            reason: step ? `${BEFORE_NOT_SAVED} (git ${step} failed).` : `${BEFORE_NOT_SAVED}.`,
          });
        }
      },
    }),
    after: local({
      handler: async (ctx, turn: ai.TurnInfo) => {
        try {
          const repo = await repository(ctx, turn.folder, turn.signal);
          if (!repo) return;
          const target = { ...repo, ...turn };
          // Git added during an agent run takes effect on the next turn.
          const before = await beforeSnapshot(ctx, target);
          if (!before) return;
          await snapshot(ctx, target, "after", before);
          await cleanedIfDeleted(ctx, target);
        } catch (cause) {
          throw new Error(AFTER_SNAPSHOT_WARNING, { cause });
        }
      },
    }),
  },
  // This notice is also in the manifest, for when the Code process cannot answer.
  { unavailable: "Couldn't save this turn's code" },
);

export const cleanup = provide(threadDeletedLocal, {
  after: local({
    handler: async (ctx, { threadId, folder }: DeletedThread) => {
      if (!folder) return;
      const repo = await repository(ctx, folder);
      if (repo) await deleteSnapshots(ctx, { ...repo, threadId });
    },
  }),
});

/** Recheck this device's recorded repositories when its local part opens. */
export const prune = local({
  handler: async (ctx) => {
    await pruneSnapshots(ctx);
    return null;
  },
});

// A running turn can publish a ref after the delete hook lists the refs.
// Check the committed deletion after publishing so the last writer cleans up.
async function cleanedIfDeleted(
  ctx: LocalContext,
  target: { root: string; threadId: Id<"threads">; signal: LocalContext["signal"] },
): Promise<boolean> {
  if (await ctx.runQuery(chat.getThread, { threadId: target.threadId })) return false;
  await deleteSnapshots(ctx, target, target.signal);
  return true;
}
