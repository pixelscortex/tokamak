import { createSignal, onCleanup } from "solid-js";
import type { ResultOf, TokamakClient } from "@tokamak/sdk";
import { api } from "../../../../client";

/** One discovery cache per chat, shared by the composer and picker. */
export function useBackends(client: TokamakClient) {
  const [data, setData] = createSignal<ResultOf<typeof api.backends.list>>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let alive = true;
  let pending: Promise<void> | undefined;
  onCleanup(() => {
    alive = false;
  });

  function refresh(): Promise<void> {
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

  void refresh();
  return { data, loading, error, refresh };
}
