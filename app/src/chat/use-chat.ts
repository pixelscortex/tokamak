import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { useQuery } from "@tokamak/sdk/solid";
import type { Id, ResultOf, TokamakClient } from "@tokamak/sdk";
import { api } from "../../../plugins/chat/client";

import { useRunRecovery } from "./use-run-recovery";
import { useIdentity } from "./use-identity";
import { useShares } from "./use-shares";

export { api };
export type Thread = ResultOf<typeof api.threads.list>[number];
export type Message = ResultOf<typeof api.messages.list>[number];
export type ChatState = ReturnType<typeof useChat>;

export function useChat(client: TokamakClient) {
  const threads = useQuery(client, api.threads.list, () => ({}));
  const [threadId, setThreadId] = createSignal<Id<"threads">>();
  const running = useQuery(client, api.runs.running, () => ({}));
  const runs = createMemo(() => Object.fromEntries((running.data() ?? []).map(run => [run.threadId, run])));
  const [error, setError] = createSignal<string>();
  const [creating, setCreating] = createSignal(false);
  let initialized = false;
  let alive = true;

  const identity = useIdentity(client, cause => setError(cause));
  const isOwner = () => identity()?.role === "owner";
  const isGuest = () => identity()?.role === "guest";

  // Owner-only subscriptions start once the server confirms the role.
  const sharing = createMemo(() => {
    const viewer = identity();
    return viewer?.role === "owner" ? useShares(client, viewer.memberId) : undefined;
  });

  async function createThread() {
    if (creating() || isGuest()) return;
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
    // Guests cannot create threads; wait for the role before the first one.
    const viewer = identity();
    if (!viewer) return;
    if (!initialized) {
      initialized = true;
      if (list.length) setThreadId(list[0]!._id);
      else if (viewer.role === "owner") void createThread();
    }
    const selected = untrack(threadId);
    if ((!selected || !list.some(thread => thread._id === selected)) && !untrack(creating)) {
      setThreadId(list[0]?._id);
    }
  });

  onCleanup(() => {
    alive = false;
  });

  useRunRecovery(client, () => isOwner() && Boolean(running.data()?.length), setError);

  const thread = createMemo(() => threads.data()?.find(item => item._id === threadId()));
  const active = () => runs()[threadId() ?? ""] ?? null;

  // The server enforces this too; the UI only avoids offering a refused stop.
  const canStop = () => {
    const run = active();
    return Boolean(run && (isOwner() || run.startedBy === identity()?.memberId));
  };

  async function cancel() {
    const run = active();
    if (!run || !canStop()) return;
    try {
      await client.mutation(api.runs.cancel, { runId: run.runId });
    } catch (cause) {
      if (alive) setError(String(cause));
    }
  }

  return {
    client, threads, threadId, thread, open: setThreadId, runs, active,
    error: () => error() ?? running.error()?.message, setError, creating, createThread, cancel,
    identity, isOwner, isGuest, canStop, sharing,
  };
}
