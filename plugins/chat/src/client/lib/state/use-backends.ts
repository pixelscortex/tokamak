import { createSignal, onCleanup } from "solid-js";
import type { ResultOf, TokamakClient } from "@tokamak/sdk";
import { api } from "../api";

/** One discovery cache per chat, shared by the composer and the agent picker. */
export function useBackends(client: TokamakClient) {
  const [data, setData] = createSignal<ResultOf<typeof api.backends.list> | undefined>(undefined, {
    ownedWrite: true,
  });
  const [loading, setLoading] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const [remote, setRemote] = createSignal(false, { ownedWrite: true });
  let alive = true;
  let pending: Promise<void> | undefined;
  onCleanup(() => {
    alive = false;
  });

  function refresh(): Promise<void> {
    if (remote()) return Promise.resolve();
    if (pending) return pending;
    setLoading(true);
    setError(undefined);
    pending = client
      .action(api.backends.list, {})
      .then((options) => {
        if (alive) setData(options);
      })
      .catch((cause) => {
        if (alive) {
          setData(undefined);
          setError(String(cause));
        }
      })
      .finally(() => {
        pending = undefined;
        if (alive) setLoading(false);
      });
    return pending;
  }

  setLoading(true);
  const stop = client.subscribe(api.backends.available, {}, (event) => {
    if ("error" in event) {
      setError(event.error.message);
      setLoading(false);
      return;
    }
    setRemote(event.value !== null);
    if (event.value === null) {
      void refresh();
      return;
    }
    setData(event.value);
    setError(undefined);
    setLoading(false);
  });
  onCleanup(stop);
  return { data, loading, error, refresh, remote };
}
