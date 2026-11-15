import { createSignal, onCleanup } from "solid-js";
import { api, type ChatState } from "./use-chat";

export function useDrafts(chat: ChatState) {
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const [sending, setSending] = createSignal<Record<string, boolean>>({});
  let alive = true;
  onCleanup(() => { alive = false; });

  async function send(text: string) {
    const threadId = chat.threadId();
    if (!threadId || !text.trim() || chat.active() || sending()[threadId]) return;
    chat.setError(undefined);
    setSending(previous => ({ ...previous, [threadId]: true }));
    setDrafts(previous => ({ ...previous, [threadId]: "" }));
    try {
      await chat.client.action(api.chat.send, { threadId, text });
    } catch (cause) {
      if (alive) {
        setDrafts(previous => ({ ...previous, [threadId]: previous[threadId] || text }));
        chat.setError(String(cause));
      }
    } finally {
      if (alive) setSending(previous => ({ ...previous, [threadId]: false }));
    }
  }

  return {
    draft: () => drafts()[chat.threadId() ?? ""] ?? "",
    sending: () => sending()[chat.threadId() ?? ""],
    edit: (text: string) => setDrafts(previous => ({ ...previous, [chat.threadId() ?? ""]: text })),
    send,
  };
}
