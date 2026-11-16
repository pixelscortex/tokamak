import { createSignal, onCleanup } from "solid-js";
import { api, type ChatState } from "./use-chat";

export function useDrafts(chat: ChatState) {
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const [sending, setSending] = createSignal<Record<string, boolean>>({});
  const [raced, setRaced] = createSignal<Record<string, boolean>>({});
  let alive = true;
  onCleanup(() => { alive = false; });

  async function send(text: string) {
    const threadId = chat.threadId();
    // During a run Enter keeps the draft and shows nothing new.
    if (!threadId || !text.trim() || chat.active() || sending()[threadId]) return;

    chat.setError(undefined);
    setRaced(previous => ({ ...previous, [threadId]: false }));
    setSending(previous => ({ ...previous, [threadId]: true }));
    setDrafts(previous => ({ ...previous, [threadId]: "" }));

    try {
      await chat.client.action(api.chat.send, { threadId, text });
    } catch (cause) {
      if (!alive) return;
      setDrafts(previous => ({ ...previous, [threadId]: previous[threadId] || text }));

      // Another member started a run first: keep the draft and name them instead.
      if (String(cause).includes("already has an active run")) setRaced(previous => ({ ...previous, [threadId]: true }));
      else chat.setError(String(cause));
    } finally {
      if (alive) setSending(previous => ({ ...previous, [threadId]: false }));
    }
  }

  return {
    draft: () => drafts()[chat.threadId() ?? ""] ?? "",
    sending: () => sending()[chat.threadId() ?? ""],
    raced: () => raced()[chat.threadId() ?? ""] ?? false,
    clearRace: () => setRaced(previous => ({ ...previous, [chat.threadId() ?? ""]: false })),
    edit: (text: string) => setDrafts(previous => ({ ...previous, [chat.threadId() ?? ""]: text })),
    send,
  };
}
