/** Optional Solid integration lives outside portable src, so backend bundles and
 * their checked ES2022-only type graph never depend on a UI runtime.
 * Each reactive argument change owns exactly one live subscription. */
import {
  createComponent,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  runWithOwner,
  useContext,
  type Accessor,
  type ContextProviderComponent,
} from "solid-js";
import type { FunctionReference } from "./src/api";
import type { TokamakClient } from "./src/client";
import { authCaller } from "./src/auth";
import type { AuthContext, Device, User } from "./src/functions";

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

type LiveCaller = User & { readonly device: Device };
const ConnectedClient = createContext<TokamakClient | null>(null);
const CallerContext = createContext<() => LiveCaller>();

const ClientProvider: ContextProviderComponent<TokamakClient> = (props) => {
  const owner = getOwner();
  const client = props.value;
  let caller: LiveCaller | undefined;
  return createComponent(ConnectedClient, {
    value: client,
    get children() {
      return createComponent(CallerContext, {
        // A read in JSX can re-run. Own the subscription above consumers so
        // they share the object and it lives until the provider is disposed.
        value: () => (caller ??= runWithOwner(owner, () => liveCaller(client))),
        get children() {
          return props.children;
        },
      });
    },
  });
};

/** The shell supplies its already-connected client; plugins never own sockets. */
// Copy Solid's context ID and default value so useContext still reads ConnectedClient.
export const ClientContext = Object.assign(ClientProvider, ConnectedClient);
export function useClient(): TokamakClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("Plugin UI requires the shell client");
  return client;
}

export const auth = Object.freeze({
  /** Get a live user and device. Reading their fields can suspend until loaded. */
  me(): LiveCaller {
    useClient();
    return useContext(CallerContext)();
  },
});

function liveCaller(client: TokamakClient): LiveCaller {
  const state = useQuery(client, authCaller, () => ({}));
  // The subscription updates the memo when identity arrives. Until then,
  // Solid can show a loading fallback without inventing an id or role.
  const pending = new Promise<AuthContext>(() => {});
  const caller = createMemo<AuthContext>(() => {
    const error = state.error();
    if (error) throw error;
    return state.data() ?? pending;
  });
  return Object.freeze({
    get id() {
      return caller().user.id;
    },
    get name() {
      return caller().user.name;
    },
    get role() {
      return caller().user.role;
    },
    device: Object.freeze({
      get id() {
        return caller().device.id;
      },
      get name() {
        return caller().device.name;
      },
    }),
  });
}
