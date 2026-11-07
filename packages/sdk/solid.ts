/** Optional Solid integration lives outside portable src, so backend bundles and
 * their checked ES2022-only type graph never depend on a UI runtime.
 * Each reactive argument change owns exactly one live subscription. */
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import type { FunctionReference } from "./src/api";
import type { TokamakClient } from "./src/client";

export interface QueryState<T> {
  data: Accessor<T | undefined>;
  loading: Accessor<boolean>;
  error: Accessor<Error | undefined>;
}

export function useQuery<A, R>(
  client: TokamakClient,
  reference: FunctionReference<"query", A, R>,
  args: Accessor<NoInfer<A>>,
): QueryState<R> {
  const [data, setData] = createSignal<R>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<Error>();

  createEffect(() => {
    const input = args();
    setData(undefined);
    setError(undefined);
    setLoading(true);
    try {
      const stop = client.subscribe(reference, input, (event) => {
        if ("value" in event) {
          setData(() => event.value);
          setError(undefined);
        } else {
          setError(event.error);
        }
        setLoading(false);
      });
      onCleanup(stop);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setLoading(false);
    }
  });
  return { data, loading, error };
}
