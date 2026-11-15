import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { useQuery } from "@tokamak/sdk/solid";
import type { Id, ResultOf, TokamakClient } from "@tokamak/sdk";
import { api } from "../../../plugins/chat/client";

export { api };
export type Thread = ResultOf<typeof api.threads.list>[number];
export type Message = ResultOf<typeof api.messages.list>[number];
export type Run = NonNullable<ResultOf<typeof api.runs.active>>;
export type ChatState = ReturnType<typeof useChat>;

export function useChat(client: TokamakClient) {
  const threads = useQuery(client, api.threads.list, () => ({}));
  const [threadId, setThreadId] = createSignal<Id<"threads">>();
  const [runs, setRuns] = createSignal<Record<string, Run | null>>({});
  const [error, setError] = createSignal<string>();
  const [creating, setCreating] = createSignal(false);
  const watching = new Map<string, () => void>();
  let initialized = false;
  let alive = true;

  async function createThread() {
    if (creating()) return;
    setCreating(true);
    setError(undefined);
    try {
      const id = await client.mutation(api.threads.create, {});
      if (alive) setThreadId(id);
      return id;
    } catch (cause) {
      if (alive) setError(String(cause));
    } finally {
      if (alive) setCreating(false);
    }
  }

  createEffect(() => {
    const list = threads.data();
    if (!list) return;
    if (!initialized) {
      initialized = true;
      if (list.length) setThreadId(list[0]!._id);
      else void createThread();
    }
    // The contract exposes active runs per thread, including offscreen ones.
    for (const thread of list) {
      if (watching.has(thread._id)) continue;
      watching.set(thread._id, client.subscribe(api.runs.active, { threadId: thread._id }, event => {
        if ("value" in event) setRuns(previous => ({ ...previous, [thread._id]: event.value }));
        else setError(event.error.message);
      }));
    }
    for (const [id, stop] of watching) {
      if (list.some(thread => thread._id === id)) continue;
      stop();
      watching.delete(id);
      setRuns(previous => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
    }
    const selected = untrack(threadId);
    if (selected && !list.some(thread => thread._id === selected) && !untrack(creating)) {
      setThreadId(list[0]?._id);
    }
  });

  onCleanup(() => {
    alive = false;
    for (const stop of watching.values()) stop();
  });

  const thread = createMemo(() => threads.data()?.find(item => item._id === threadId()));
  const active = () => runs()[threadId() ?? ""] ?? null;

  async function cancel() {
    const run = active();
    if (!run) return;
    try {
      await client.mutation(api.runs.cancel, { runId: run._id });
    } catch (cause) {
      if (alive) setError(String(cause));
    }
  }

  return { client, threads, threadId, thread, open: setThreadId, runs, active, error, setError, creating, createThread, cancel };
}
