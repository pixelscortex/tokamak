import { createSignal } from "solid-js";
import { api, type ChatState, type Thread } from "./use-chat";

/** Rename and delete for one thread at a time; each opens its own dialog. */
export function useThreadEditor(chat: ChatState) {
  const [editing, setEditing] = createSignal<{ mode: "rename" | "delete"; thread: Thread } | undefined>(
    undefined,
    {
      ownedWrite: true,
    },
  );
  const [busy, setBusy] = createSignal(false, { ownedWrite: true });

  async function save(title?: string) {
    const current = editing();
    if (!current || busy()) return false;
    if (current.mode === "rename" && !title?.trim()) return false;
    setBusy(true);
    try {
      if (current.mode === "rename")
        await chat.client.mutation(api.threads.rename, { threadId: current.thread._id, title: title! });
      else await chat.client.mutation(api.threads.remove, { threadId: current.thread._id });
      setEditing(undefined);
      return true;
    } catch (cause) {
      chat.setError(String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return {
    editing,
    busy,
    begin: (thread: Thread, mode: "rename" | "delete") => setEditing({ mode, thread }),
    close: () => setEditing(undefined),
    save,
  };
}
