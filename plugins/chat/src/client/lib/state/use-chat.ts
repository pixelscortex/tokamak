import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { useQuery } from "@tokamak/sdk/solid";
import type { Id, ResultOf, TokamakClient } from "@tokamak/sdk";
import { account, api } from "../api";
import type { RemoteChat } from "@tokamak/sdk/client";
import { agentOf } from "../agents";
import { useBackends } from "./use-backends";
import { useRunRecovery } from "./use-run-recovery";

export { api };
export type Thread = ResultOf<typeof api.threads.list>[number];
export type ChatState = ReturnType<typeof useChat>;

// Survives the view being closed and reopened; the server owns everything else.
let lastThread: Id<"threads"> | undefined;

export function useChat(client: TokamakClient, remote?: RemoteChat) {
  const threads = useQuery(client, api.threads.list, () => ({}));
  const running = useQuery(client, api.runs.running, () => ({}));
  const [userId, setUserId] = createSignal<string | undefined>(remote ? undefined : "local", {
    ownedWrite: true,
  });
  const [selection, changed] = createSignal(0, { ownedWrite: true });
  const [threadId, setThreadId] = createSignal<Id<"threads"> | undefined>(lastThread, { ownedWrite: true });
  const [error, setError] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const [creating, setCreating] = createSignal(false, { ownedWrite: true });
  const runs = createMemo(() => Object.fromEntries((running.data() ?? []).map((run) => [run.threadId, run])));
  const discovery = useBackends(() =>
    remote ? (remote.machine?.list() ?? Promise.resolve([])) : client.action(api.backends.list, {}),
  );
  let initialized = false;
  let alive = true;
  let disconnected = false;
  onCleanup(() => {
    alive = false;
  });

  if (remote)
    void client.query(account.whoami, {}).then(
      (user) => {
        if (alive) setUserId(user.id);
      },
      (error) => {
        if (alive) setError(String(error));
      },
    );

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

  if (!remote) useRunRecovery(client, () => Boolean(running.data()?.length), setError);

  const thread = createMemo(() => threads.data()?.find((item) => item._id === threadId()));
  const active = () => runs()[threadId() ?? ""] ?? null;
  const currentRuns = () => (running.data() ?? []).filter((run) => run.threadId === threadId());
  const key = (id: Id<"threads">) => `chat:machine:${JSON.stringify([remote?.hub, userId(), id])}`;
  const folderKey = (id: Id<"threads">, backendId: string) => `${key(id)}:${backendId}`;
  const backend = (id = threadId()) => {
    if (!remote) return thread()?.backend;
    selection();
    if (!id || !userId() || !remote.machine) return undefined;
    const chosen = localStorage.getItem(key(id));
    if (!chosen) return undefined;
    return {
      kind: "plugin" as const,
      plugin: "acp",
      backendId: chosen,
      settings: { cwd: localStorage.getItem(folderKey(id, chosen)) ?? "" },
    };
  };
  const agent = createMemo(() => agentOf(backend(), discovery.data()));

  async function setMachineAgent(id: Id<"threads">, backendId?: string, path?: string) {
    if (!remote?.machine || !userId()) throw new Error("This computer has no agent connection yet.");
    const k = key(id);
    if (!backendId) localStorage.removeItem(k);
    else {
      const folder = folderKey(id, backendId);
      if (path !== undefined) localStorage.setItem(folder, await remote.machine.configure(backendId, path));
      localStorage.setItem(k, backendId);
    }
    changed((value) => value + 1);
  }

  function submit(id: Id<"threads">, text: string) {
    const current = backend(id);
    if (!remote) return client.action(api.chat.send, { threadId: id, text });
    if (!current) return client.mutation(api.messages.post, { threadId: id, text });
    if (!remote.machine) throw new Error("Agents run from the desktop app on your own computer.");
    return remote.machine.send({
      threadId: id,
      text,
      backendId: current.backendId,
      cwd: agentOf(current)?.folder ?? "",
      requestId: crypto.randomUUID(),
    });
  }

  async function cancel(runId = active()?.runId) {
    if (!runId) return;
    try {
      await client.mutation(api.runs.cancel, { runId });
    } catch (cause) {
      if (alive) setError(String(cause));
    }
  }

  return {
    client,
    remote,
    userId,
    backend,
    setMachineAgent,
    submit,
    currentRuns,
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
