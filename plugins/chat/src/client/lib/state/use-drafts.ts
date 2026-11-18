import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { api } from "../api";
import type { ChatState } from "./use-chat";

type PerThread<T> = Record<string, T>;

// Drafts and queued follow-ups outlive the view, so closing chat loses nothing typed.
const kept: { drafts: PerThread<string>; queued: PerThread<string> } = { drafts: {}, queued: {} };

export function useDrafts(chat: ChatState) {
  const [drafts, setDrafts] = createSignal<PerThread<string>>(kept.drafts, { ownedWrite: true });
  const [queued, setQueued] = createSignal<PerThread<string>>(kept.queued, { ownedWrite: true });
  const [sending, setSending] = createSignal<PerThread<boolean>>({}, { ownedWrite: true });
  const [raced, setRaced] = createSignal<PerThread<boolean>>({}, { ownedWrite: true });
  let alive = true;
  onCleanup(() => {
    alive = false;
  });

  const key = () => chat.threadId() ?? "";
  // The kept copies are written even after the view closes; only the signals need it open.
  function write(threadId: string, text: string) {
    kept.drafts = { ...kept.drafts, [threadId]: text };
    if (alive) setDrafts(kept.drafts);
  }
  function queue(threadId: string, text: string | undefined) {
    const { [threadId]: _previous, ...rest } = kept.queued;
    kept.queued = text ? { ...rest, [threadId]: text } : rest;
    if (alive) setQueued(kept.queued);
  }

  async function sendTo(threadId: string, text: string) {
    chat.setError(undefined);
    setRaced((previous) => ({ ...previous, [threadId]: false }));
    setSending((previous) => ({ ...previous, [threadId]: true }));
    try {
      if (chat.remote) await chat.submit(threadId as never, text);
      else await chat.client.action(api.chat.send, { threadId: threadId as never, text });
    } catch (cause) {
      // Put the text back where it was typed, unless something new was typed since.
      if (!kept.drafts[threadId]) write(threadId, text);
      if (!alive) return;
      if (!chat.remote && String(cause).includes("already has an active run"))
        setRaced((previous) => ({ ...previous, [threadId]: true }));
      else chat.setError(String(cause));
      void chat.backendDiscovery.refresh();
    } finally {
      if (alive) setSending((previous) => ({ ...previous, [threadId]: false }));
    }
  }

  /** Sends now when idle; while a reply runs, queues the text as the next turn. */
  async function send(text: string) {
    const threadId = key();
    if (chat.creating() || !threadId || !text.trim()) return;
    write(threadId, "");
    if (!chat.remote && (chat.active() || untrack(sending)[threadId])) {
      const before = untrack(queued)[threadId];
      queue(threadId, before ? `${before}\n\n${text}` : text);
      return;
    }
    await sendTo(threadId, text);
  }

  // A queued follow-up goes out when its thread's run ends, even if another thread is open.
  createEffect(
    () => [chat.runs(), sending(), queued(), chat.runsLoaded()] as const,
    ([runs, busy, waiting, loaded]) => {
      // Until the running list has arrived, an empty list does not mean idle.
      if (chat.remote || !loaded) return;
      setRaced((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => runs[id])));
      for (const [threadId, text] of Object.entries(waiting)) {
        if (runs[threadId] || busy[threadId]) continue;
        queue(threadId, undefined);
        void sendTo(threadId, text);
      }
    },
  );

  return {
    draft: () => drafts()[key()] ?? "",
    queued: () => queued()[key()] ?? "",
    sending: () => Boolean(sending()[key()]),
    raced: () => raced()[key()] ?? false,
    clearRace: () => setRaced((previous) => ({ ...previous, [key()]: false })),
    edit: (text: string) => write(key(), text),
    /** Takes the queued follow-up back into the draft. */
    unqueue() {
      const text = untrack(queued)[key()];
      if (!text) return;
      queue(key(), undefined);
      const draft = untrack(drafts)[key()];
      write(key(), draft ? `${text}\n\n${draft}` : text);
    },
    send,
  };
}
