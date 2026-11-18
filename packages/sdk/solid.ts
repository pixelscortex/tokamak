/** Optional Solid integration lives outside portable src, so backend bundles and
 * their checked ES2022-only type graph never depend on a UI runtime.
 * Each reactive argument change owns exactly one live subscription. */
import { createContext, useContext, createEffect, createSignal } from "solid-js";
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
  const [data, setData] = createSignal<R | undefined>(undefined, { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [error, setError] = createSignal<Error | undefined>(undefined, { ownedWrite: true });

  createEffect(args, (input) => {
    let active = true;
    setData(undefined);
    setError(undefined);
    setLoading(true);
    try {
      const stop = client.subscribe(reference, input, (event) => {
        if (!active) return;
        if ("value" in event) {
          setData(() => event.value);
          setError(undefined);
        } else setError(event.error);
        setLoading(false);
      });
      return () => {
        active = false;
        stop();
      };
    } catch (cause) {
      active = false;
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setLoading(false);
    }
  });
  return { data, loading, error };
}

/** The shell supplies its already-connected client; plugins never own sockets. */
export const ClientContext = createContext<TokamakClient>();
export function useClient(): TokamakClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("Plugin UI requires the shell client");
  return client;
}
