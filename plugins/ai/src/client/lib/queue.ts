import { isFailure, type Id, type TokamakClient } from "@tokamak/sdk";
import { resolveFolder } from "plugin:chat/client";
import type { TurnView } from "../../server/_functions";
import { runLocalTurn } from "./local-turn";
import { errorText } from "../../shared/turn-shared";
import { api, notice, reasonLine } from "./agents";

/** Watch across threads: the first snapshot after reloading can pick up a ready queue too. */
export function watchQueue(client: TokamakClient): () => void {
  if (!client.hasLocal) return () => {};
  let closed = false;
  let heads: TurnView[] = [];
  const launching = new Set<string>();
  const attempted = new Set<Id<"turns">>();

  function launchReady() {
    if (closed) return;
    for (const head of heads) {
      if (attempted.has(head._id) || launching.has(head.threadId)) continue;
      attempted.add(head._id);
      launching.add(head.threadId);
      void launchQueued(client, head, () => closed)
        .catch(async (cause: unknown) => {
          if (closed) return;
          notice.set(`The queue could not run: ${errorText(cause)}`);
          await settle(client, head, `The queue could not run: ${errorText(cause)}`);
        })
        .finally(() => {
          launching.delete(head.threadId);
          launchReady();
        });
    }
  }

  const unlisten = client.subscribe(api.turns.ready, {}, (event) => {
    if ("error" in event) {
      notice.set(`The queue could not run: ${errorText(event.error)}`);
      return;
    }
    heads = event.value;
    for (const id of attempted) if (!heads.some((head) => head._id === id)) attempted.delete(id);
    launchReady();
  });
  return () => {
    closed = true;
    unlisten();
  };
}

async function launchQueued(client: TokamakClient, head: TurnView, isClosed: () => boolean) {
  const threadId = head.threadId as Id<"threads">;
  const folder = await resolveFolder(client, threadId);
  if (isClosed()) return;
  if (folder === undefined) {
    const reason = "The queue could not run: this thread's folder could not be resolved.";
    notice.set(reason);
    return settle(client, head, reason);
  }
  const result = await runLocalTurn(client, {
    threadId,
    messageId: head.messageId,
    folder,
    agentId: head.agent.id,
  });
  if (result === undefined) return;
  if (isFailure(result)) {
    // Busy: another turn holds the thread; this head starts when it ends.
    if (result.kind !== "Busy") await settle(client, head, reasonLine(result.kind, head.agent.name));
  } else if (!isClosed() && "ended" in result && result.ended) {
    notice.set(result.ended);
  } else if (!isClosed() && "hookNotice" in result && result.hookNotice) {
    notice.set(result.hookNotice);
  }
}

/**
 * A head this window cannot start would block its thread until the server
 * settles it as "Tokamak was closed": settle it now, with the real reason.
 * Does nothing once the head has begun or left the front of its queue.
 */
async function settle(client: TokamakClient, head: TurnView, error: string) {
  await client.mutation(api.turns.failQueued, { turnId: head._id, error }).catch(() => {});
}
