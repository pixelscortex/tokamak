// The client is a typed adapter, not a connection manager. In-process and
// WebSocket transports implement the same injected operations; the SDK never
// accesses sockets, timers, console, or other environment-specific globals.
import { functionName } from "./api";
import type { FunctionReference } from "./api";
import type { JsonValue } from "./values";
import { assertJson, jsonSnapshot } from "./values";
import type { ActionOptions, ActionTarget, MachineFailure } from "./functions";
import type { ActionSignal } from "./host";
import { isWindowStateFunction } from "./window-state-protocol";

/** An admitted local call did not settle before its old build was closed on reload. */
export class LocalReloadTimeout extends Error {
  constructor() {
    super("Local plugin build retired");
    this.name = "LocalReloadTimeout";
  }
}

/** The runtime and the plugin may each have their own copy of the SDK. */
export function isLocalReloadTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "LocalReloadTimeout";
}

export interface LocalTransport {
  action?(
    name: string,
    args: JsonValue,
    options?: ActionOptions & { signal?: ActionSignal },
  ): Promise<JsonValue>;
  invoke(name: string, args: JsonValue, signal?: ActionSignal): Promise<JsonValue>;
}

/** Terminal errors mean the transport has removed the subscription. A new
 * subscribe call is required to retry; ordinary rerun errors can still recover. */
export type SubscriptionEvent<T> = { value: T } | { error: Error; terminal?: boolean };

export interface ClientTransport {
  query(name: string, args: JsonValue): Promise<JsonValue>;
  mutation(name: string, args: JsonValue): Promise<JsonValue>;
  /** Optional for existing custom transports; current native/WebSocket transports implement it. */
  action?(name: string, args: JsonValue, on?: ActionTarget): Promise<JsonValue>;
  /**
   * Transport owns initial delivery, update ordering and error delivery. If
   * registration itself throws, it must clean up resources before throwing.
   */
  subscribe(
    name: string,
    args: JsonValue,
    onEvent: (event: SubscriptionEvent<JsonValue>) => void,
  ): () => void;
}

export class TokamakClient {
  readonly #transport: ClientTransport;
  readonly #localTransport?: LocalTransport;

  constructor(transport: ClientTransport, localTransport?: LocalTransport) {
    this.#transport = transport;
    this.#localTransport = localTransport;
  }

  async query<A, R>(reference: FunctionReference<"query", A, R>, args: NoInfer<A>): Promise<R> {
    const value = await this.#transport.query(publicName(reference), jsonSnapshot(args, "args"));
    assertJson(value, "query result");
    return value as R;
  }

  async mutation<A, R>(reference: FunctionReference<"mutation", A, R>, args: NoInfer<A>): Promise<R> {
    const value = await this.#transport.mutation(publicName(reference), jsonSnapshot(args, "args"));
    assertJson(value, "mutation result");
    return value as R;
  }

  action<A, R>(reference: FunctionReference<"action", A, R>, args: NoInfer<A>): Promise<R>;
  action<A, R>(
    reference: FunctionReference<"action", A, R>,
    args: NoInfer<A>,
    options: ActionOptions & { signal?: ActionSignal },
  ): Promise<R | MachineFailure>;
  async action<A, R>(
    reference: FunctionReference<"action", A, R>,
    args: NoInfer<A>,
    options?: ActionOptions & { signal?: ActionSignal },
  ): Promise<R | MachineFailure> {
    const name = publicName(reference);
    const input = jsonSnapshot(args, "args");
    const value = this.#localTransport?.action
      ? await this.#localTransport.action(name, input, options)
      : await this.#transport.action?.(name, input, options?.on);
    if (value === undefined) throw new Error("Transport does not support actions");
    assertJson(value, "action result");
    return value as R;
  }

  /** True when this window has a local part (the desktop client) to run `local` functions. */
  get hasLocal(): boolean {
    return this.#localTransport !== undefined;
  }

  async local<A, R>(
    reference: FunctionReference<"local", A, R>,
    args: NoInfer<A>,
    options?: { signal?: ActionSignal },
  ): Promise<R> {
    if (!this.#localTransport) throw new Error("Local functions require the Tokamak desktop client");
    const value = await this.#localTransport.invoke(
      publicName(reference),
      jsonSnapshot(args, "args"),
      options?.signal,
    );
    assertJson(value, "local result");
    return value as R;
  }

  subscribe<A, R>(
    reference: FunctionReference<"query", A, R>,
    args: NoInfer<A>,
    onEvent: (event: SubscriptionEvent<NoInfer<R>>) => void,
  ): () => void {
    let active = true;
    let registering = true;
    let initialFailure = false;
    let initialError: unknown;
    let stop: () => void;

    const notify = (event: SubscriptionEvent<JsonValue>) => {
      if ("value" in event) {
        try {
          assertJson(event.value, "subscription result");
        } catch (error) {
          onEvent({
            error: error instanceof Error ? error : new Error(String(error)),
          });
          return;
        }
      }
      onEvent(event as SubscriptionEvent<R>);
    };

    try {
      stop = this.#transport.subscribe(publicName(reference), jsonSnapshot(args, "args"), (event) => {
        if (!active) return;
        try {
          notify(event);
        } catch (error) {
          if (!registering) throw error;
          // A synchronous observer must not abort transport registration:
          // first capture its disposer, then close and rethrow the original
          // failure. A separate flag also preserves `throw undefined`.
          active = false;
          initialFailure = true;
          initialError = error;
        }
      });
    } catch (error) {
      active = false;
      throw error;
    } finally {
      registering = false;
    }
    if (initialFailure) {
      try {
        stop();
      } catch {
        /* The observer failure takes precedence over cleanup failures. */
      }
      throw initialError;
    }
    // Closing twice is harmless; late transport events must not reach the UI.
    return () => {
      if (active) {
        active = false;
        stop();
      }
    };
  }
}

function publicName(reference: { readonly [functionName]: string }): string {
  const name = reference[functionName];
  if (isWindowStateFunction(name)) throw new Error("Window state is private to its plugin");
  return name;
}
