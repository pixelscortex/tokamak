import { createSignal } from "solid-js";
import type { Id, TokamakClient } from "@tokamak/sdk";
import { api } from "./api";
import { announceSent, submitDraft, type DraftIntent } from "./sent";
import { draftOf, error, errorText, setDraft } from "./state";

/**
 * One Send, for the new thread and for an open one: store the text, make sure
 * the thread's folder exists on this computer, clear the draft, then announce
 * it. The text stays in the composer until it is stored.
 */
export function createSend(
  client: TokamakClient,
  options: {
    draftKey: () => string;
    threadId?: () => Id<"threads">;
    store: (text: string) => Promise<{ threadId: Id<"threads">; messageId: Id<"messages">; first: boolean }>;
  },
) {
  const [sending, setSending] = createSignal(false, { ownedWrite: true });
  async function send(intent: DraftIntent = "steer") {
    const key = options.draftKey();
    const text = draftOf(key).trim();
    if (!text || sending()) return;
    setSending(true);
    error.set(undefined);
    try {
      const threadId = options.threadId?.();
      if (threadId && (await submitDraft({ threadId, text, intent }))) {
        if (draftOf(key).trim() === text) setDraft(key, "");
        return;
      }
      const stored = await options.store(text);
      setDraft(key, "");
      let folder: string | undefined;
      try {
        folder = await resolveFolder(client, stored.threadId);
      } catch (cause) {
        // The message is stored; nothing may work in a thread without its folder.
        error.set(`Couldn't make this thread's folder: ${errorText(cause)}`);
        return;
      }
      announceSent({ ...stored, text, folder });
    } catch (cause) {
      error.set(errorText(cause));
    } finally {
      setSending(false);
    }
  }
  return { send, sending };
}

export function resolveFolder(client: TokamakClient, threadId: Id<"threads">) {
  return client.hasLocal
    ? client.local(api.folders.resolve, { threadId }).then((path) => path ?? undefined)
    : Promise.resolve(undefined);
}
