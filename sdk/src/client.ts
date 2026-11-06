// The client is a typed adapter, not a connection manager. In-process and
// WebSocket transports implement the same injected operations; the SDK never
// accesses sockets, timers, console, or other environment-specific globals.
import { functionName } from './api';
import type { FunctionReference } from './api';
import type { JsonValue } from './values';
import { assertJson, jsonSnapshot } from './values';

export type SubscriptionEvent<T> = { value: T } | { error: Error };
export interface ClientTransport {
  query(name: string, args: JsonValue): Promise<JsonValue>;
  mutation(name: string, args: JsonValue): Promise<JsonValue>;
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
  constructor(private readonly transport: ClientTransport) {}

  async query<A, R>(
    reference: FunctionReference<'query', A, R>,
    args: NoInfer<A>,
  ): Promise<R> {
    const value = await this.transport.query(
      reference[functionName],
      jsonSnapshot(args, 'args'),
    );
    assertJson(value, 'query result');
    return value as R;
  }

  async mutation<A, R>(
    reference: FunctionReference<'mutation', A, R>,
    args: NoInfer<A>,
  ): Promise<R> {
    const value = await this.transport.mutation(
      reference[functionName],
      jsonSnapshot(args, 'args'),
    );
    assertJson(value, 'mutation result');
    return value as R;
  }

  subscribe<A, R>(
    reference: FunctionReference<'query', A, R>,
    args: NoInfer<A>,
    onEvent: (event: SubscriptionEvent<NoInfer<R>>) => void,
  ): () => void {
    let active = true;
    let registering = true;
    let initialFailure = false;
    let initialError: unknown;
    let stop: () => void;
    const notify = (event: SubscriptionEvent<JsonValue>) => {
      if ('value' in event) {
        try {
          assertJson(event.value, 'subscription result');
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
      stop = this.transport.subscribe(
        reference[functionName],
        jsonSnapshot(args, 'args'),
        (event) => {
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
        },
      );
    } catch (error) {
      active = false;
      throw error;
    } finally {
      registering = false;
    }
    if (initialFailure) {
      try {
        stop();
      } finally {
        throw initialError;
      }
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
