import { isFailure, type TokamakClient } from "@tokamak/sdk";
import { onSent, type Sent } from "plugin:chat/client";
import { runLocalTurn } from "./local-turn";
import { errorText } from "../../shared/turn-shared";
import { connectedClient, notice, reasonLine, unavailable } from "./agents";
import { threadChoices, toStored } from "./choices";
import { guardQuit } from "./quit";
import { watchQueue } from "./queue";
import { releaseOrphanedTurns } from "./release";

/**
 * After a Send in this window, runs the turn on this computer's local part
 * with the thread's choices (`threadChoices`). Without an agent or a local
 * part (a plain browser), the message stays plain chat.
 */
export async function startTurn(client: TokamakClient, sent: Sent): Promise<void> {
  notice.set(undefined);
  try {
    // Chat gives no folder on any computer but the thread creator's: their Send stays plain chat.
    if (sent.folder === undefined) return;
    const resolved = await threadChoices(client, sent.threadId, sent.first);
    if (!resolved || unavailable(resolved.agent)) return;
    // Only what the agent offers: a local call takes JSON, where undefined is not a value.
    const { agent: _agent, ...settings } = toStored(resolved);
    const result = await runLocalTurn(client, {
      threadId: sent.threadId,
      messageId: sent.messageId,
      folder: sent.folder,
      agentId: resolved.agent.id,
      ...settings,
    });
    // The row was a moment out of date, or the thread is busy: say what the local part found.
    if (isFailure(result))
      notice.set(
        reasonLine(
          result.kind,
          "agent" in result.data ? result.data.agent : resolved.agent.name,
          "updateRequired" in result.data ? result.data.updateRequired : undefined,
        ),
      );
    else if ("ended" in result && result.ended) notice.set(result.ended);
    else if ("hookNotice" in result && result.hookNotice) notice.set(result.hookNotice);
  } catch (cause) {
    notice.set(`The turn could not run: ${errorText(cause)}`);
  }
}

let queueClient: TokamakClient | undefined;
let unlistenQueue: (() => void) | undefined;

/** Once chat has a connection, keep the queue alive when its composers unmount. */
export function listenForQueue(client: TokamakClient): void {
  if (queueClient === client) return;
  unlistenQueue?.();
  queueClient = client;
  unlistenQueue = watchQueue(client);
  void releaseOrphanedTurns(client).catch(() => {});
}

const listening = Symbol.for("tokamak.ai.onSent");
type Listening = typeof globalThis & { [listening]?: () => void };

/**
 * Listens for Sends once per window, whatever composers are mounted: two
 * composers never start two turns, and a composer that unmounts mid-Send
 * (the new thread becoming an open one) never loses its turn. A reloaded
 * `ai` replaces the listeners of the build before it.
 */
export function listenForSends(): void {
  const scope = globalThis as Listening;
  scope[listening]?.();
  const unlistenSends = onSent((sent) => {
    const client = connectedClient();
    if (client) void startTurn(client, sent);
  });
  const unguardQuit = guardQuit(() => {
    unlistenQueue?.();
    unlistenQueue = undefined;
  });
  scope[listening] = () => {
    unlistenSends();
    unguardQuit();
    unlistenQueue?.();
    queueClient = undefined;
  };
}
