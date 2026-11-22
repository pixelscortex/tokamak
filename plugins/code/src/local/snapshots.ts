/// <reference types="node" />
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Id, LocalContext } from "@tokamak/sdk";
import { api as chat } from "plugin:chat/server";
import { deleteSnapshots } from "./git";

type Tracked = { root: string; threadId: Id<"threads"> };

function key(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Where this device records its repositories; `undefined` when the client gave no data folder. */
function directory(ctx: LocalContext): string | undefined {
  const base = process.env.TOKAMAK_APP_DATA_DIR;
  if (!base || !isAbsolute(base)) return undefined;
  // Two servers can use the same repository. Only inspect refs recorded by this device key.
  return join(base, "code", "snapshots", key(ctx.auth.user.id, ctx.auth.device.id));
}

/**
 * Records a repository for the cleanup on the next Chat open. Best-effort: the record only
 * helps remove snapshot refs later, so a missing data folder or a failed write is logged
 * and never stops the turn.
 */
export async function trackSnapshots(ctx: LocalContext, tracked: Tracked): Promise<void> {
  try {
    await record(ctx, tracked);
  } catch (cause) {
    // oxlint-disable-next-line no-console -- The local worker sends console output to the client's log.
    console.warn(`code: could not record this repository for later cleanup: ${String(cause)}`);
  }
}

async function record(ctx: LocalContext, { root, threadId }: Tracked): Promise<void> {
  const dir = directory(ctx);
  if (!dir) throw new Error("the client did not provide its data folder");
  await mkdir(dir, { recursive: true });
  const file = join(dir, key(threadId, root));
  const temporary = file + "." + crypto.randomUUID();
  await writeFile(temporary, JSON.stringify({ root, threadId }), { mode: 0o600 });
  try {
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function pruneSnapshots(ctx: LocalContext): Promise<void> {
  const dir = directory(ctx);
  if (!dir) return; // Nothing was recorded without a data folder.
  const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of files) {
    if (!/^[a-f\d]{64}$/.test(name)) continue;
    const file = join(dir, name);
    try {
      const tracked: Tracked = JSON.parse(await readFile(file, "utf8"));
      if (name !== key(tracked.threadId, tracked.root) || !isAbsolute(tracked.root)) continue;
      if (await ctx.runQuery(chat.getThread, { threadId: tracked.threadId })) continue;
      await deleteSnapshots(ctx, tracked);
      await unlink(file);
    } catch {
      // An unavailable drive, server, or repository can be checked the next time the client starts.
    }
  }
}
