import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { useQuery } from "@tokamak/sdk/solid";
import type { Id, ResultOf, TokamakClient } from "@tokamak/sdk";
import { api } from "../api";
import { agentOf } from "../agents";
import { useBackends } from "./use-backends";
import { useRunRecovery } from "./use-run-recovery";

export { api };
export type Thread = ResultOf<typeof api.threads.list>[number];
export type ChatState = ReturnType<typeof useChat>;

// Survives the view being closed and reopened; the server owns everything else.
let lastThread: Id<"threads"> | undefined;

export function useChat(client: TokamakClient) {
  const threads = useQuery(client, api.threads.list, () => ({}));
  const running = useQuery(client, api.runs.running, () => ({}));
  const [threadId, setThreadId] = createSignal<Id<"threads"> | undefined>(lastThread, { ownedWrite: true });
  const [error, setError] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const [creating, setCreating] = createSignal(false, { ownedWrite: true });
  const runs = createMemo(() => Object.fromEntries((running.data() ?? []).map((run) => [run.threadId, run])));
  const discovery = useBackends(client);
  let initialized = false;
  let alive = true;
  let disconnected = false;
  onCleanup(() => {
    alive = false;
  });

  // A restored subscription means discovery can reach the server again.
  createEffect(
    () => [threads.error(), threads.data()] as const,
    ([failure, data]) => {
      if (failure) disconnected = true;
      else if (data && disconnected) {
        disconnected = false;
        void discovery.refresh();
      }
    },
  );

  function open(id: Id<"threads"> | undefined) {
    lastThread = id;
    setThreadId(id);
  }

  async function createThread() {
    if (untrack(creating)) return;
    setCreating(true);
    setError(undefined);
    try {
      const id = await client.action(api.threads.create, {});
      if (alive) open(id);
      return id;
    } catch (cause) {
      if (alive) setError(String(cause));
    } finally {
      if (alive) setCreating(false);
    }
  }

  createEffect(threads.data, (list) => {
    if (!list) return;
    if (!initialized) {
      initialized = true;
      if (!list.length) void createThread();
    }
    const selected = untrack(threadId);
    if ((!selected || !list.some((thread) => thread._id === selected)) && !untrack(creating))
      open(list[0]?._id);
  });

  useRunRecovery(client, () => Boolean(running.data()?.length), setError);

  const thread = createMemo(() => threads.data()?.find((item) => item._id === threadId()));
  const active = () => runs()[threadId() ?? ""] ?? null;
  const agent = createMemo(() => agentOf(thread()?.backend, discovery.data()));

  async function cancel() {
    const run = active();
    if (!run) return;
    try {
      await client.mutation(api.runs.cancel, { runId: run.runId });
    } catch (cause) {
      if (alive) setError(String(cause));
    }
  }

  return {
    client,
    backends: discovery.data,
    backendDiscovery: discovery,
    noAgents: () => discovery.data()?.length === 0,
    threads,
    threadId,
    thread,
    agent,
    open,
    runs,
    /** False until the server's list of running replies has arrived. */
    runsLoaded: () => running.data() !== undefined,
    active,
    error: () => error() ?? running.error()?.message ?? threads.error()?.message,
    setError,
    creating,
    createThread,
    cancel,
    canStop: () => Boolean(active()),
  };
}
