import { afterDelay } from "@tokamak/render";
import { createEffect, createMemo, createSignal, getOwner, onCleanup, runWithOwner, untrack } from "solid-js";
import { useQuery } from "@tokamak/sdk/solid";
import type { Id, ResultOf, TokamakClient } from "@tokamak/sdk";
import { CHAT_MODELS, DEFAULT_MODEL } from "../../../plugins/chat/models";
import { api } from "../../../plugins/chat/client";

export { api };
export type Thread = ResultOf<typeof api.threads.list>[number];
export type Message = ResultOf<typeof api.messages.list>[number];
export type Run = ResultOf<typeof api.runs.running>[number];
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
    const selected = untrack(threadId);
    if ((!selected || !list.some(thread => thread._id === selected)) && !untrack(creating)) {
      setThreadId(list[0]?._id);
    }
  });

  onCleanup(() => {
    alive = false;
  });

  const owner = getOwner();
  let sweep: { stop: () => void; schedule: () => void } | undefined;
  let schedulingErrorLogged = false;
  onCleanup(() => sweep?.stop());

  createEffect(() => {
    if (!running.data()?.length) {
      sweep?.stop();
      sweep = undefined;
      return;
    }
    if (sweep) {
      sweep.schedule();
      return;
    }
    let stopped = false;
    let recovering = false;
    let cancelDelay: (() => void) | undefined;

    function schedule() {
      if (stopped || recovering || cancelDelay) return;
      try {
        cancelDelay = runWithOwner(owner, () => afterDelay(30_000, () => {
          cancelDelay = undefined;
          void recover();
        }));
      } catch (cause) {
        if (!schedulingErrorLogged) {
          const message = `Could not schedule stale-run recovery: ${String(cause)}`;
          const logger = (globalThis as { console?: { error: (message: string) => void } }).console;
          if (logger) logger.error(message);
          else setError(message);
          schedulingErrorLogged = true;
        }
      }
    }

    async function recover() {
      recovering = true;
      try {
        await client.mutation(api.runs.recover, {});
      } catch (cause) {
        if (!stopped) setError(String(cause));
      } finally {
        recovering = false;
        schedule();
      }
    }

    sweep = { stop: () => { stopped = true; cancelDelay?.(); }, schedule };
    void recover();
  });

  const thread = createMemo(() => threads.data()?.find(item => item._id === threadId()));
  const active = () => runs()[threadId() ?? ""] ?? null;

  async function cancel() {
    const run = active();
    if (!run) return;
    try {
      await client.mutation(api.runs.cancel, { runId: run.runId });
    } catch (cause) {
      if (alive) setError(String(cause));
    }
  }

  async function cycleModel() {
    const current = thread();
    if (!current) return;
    const index = CHAT_MODELS.findIndex(model => model === (current.model ?? DEFAULT_MODEL));
    try {
      await client.mutation(api.threads.setModel, { threadId: current._id, model: CHAT_MODELS[(index + 1) % CHAT_MODELS.length]! });
    } catch (cause) {
      if (alive) setError(String(cause));
    }
  }

  return { cycleModel, client, threads, threadId, thread, open: setThreadId, runs, active, error: () => error() ?? running.error()?.message, setError, creating, createThread, cancel };
}
