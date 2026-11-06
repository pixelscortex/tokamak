// Correlation and subscription lifecycle are shared by both transports. Hosts
// provide an ordered native message connection or an already-open WebSocket;
// this module installs no browser/Node globals and performs no automatic retry.
import type { ClientTransport, SubscriptionEvent } from "./client";
import type { Event, Request } from "./protocol";
import type { JsonValue } from "./values";
import { assertJson } from "./values";

export interface MessageConnection {
  send(request: Request): void;
  listen(onEvent: (event: Event) => void, onClose: (error?: Error) => void): () => void;
  close(): void;
}

type Pending = { resolve(value: JsonValue): void; reject(error: Error): void };
type Observer = (event: SubscriptionEvent<JsonValue>) => void;
const CAPACITY = 128;

export class InProcessTransport implements ClientTransport {
  private next = 0;
  private closed: Error | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Map<number, Observer>();
  private unlisten: () => void = () => {};

  constructor(private readonly connection: MessageConnection) {
    const stop = connection.listen(
      (event) => this.receive(event),
      (error) =>
        this.fail(error ?? new Error("connection closed; mutation outcomes may be unknown")),
    );
    // Some native hosts can report a closed connection synchronously at listen.
    if (this.closed) stop();
    else this.unlisten = stop;
  }

  query(name: string, args: JsonValue): Promise<JsonValue> {
    return this.call("query", name, args);
  }

  mutation(name: string, args: JsonValue): Promise<JsonValue> {
    return this.call("mutation", name, args);
  }

  private id(): number {
    if (this.closed) throw this.closed;
    if (this.next === Number.MAX_SAFE_INTEGER) throw new Error("request IDs exhausted");
    return ++this.next;
  }

  private send(request: Request): void {
    if (this.closed) throw this.closed;
    try {
      this.connection.send(request);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.fail(failure);
      throw failure;
    }
  }

  private call(type: "query" | "mutation", name: string, args: JsonValue): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      if (this.pending.size >= CAPACITY) throw new Error("client call capacity exceeded");
      const id = this.id();
      this.pending.set(id, { resolve, reject });
      this.send({ type, id, name, args });
    });
  }

  subscribe(name: string, args: JsonValue, observer: Observer): () => void {
    if (this.subscriptions.size >= CAPACITY)
      throw new Error("client subscription capacity exceeded");
    const id = this.id();
    this.subscriptions.set(id, observer);
    try {
      this.send({ type: "subscribe", id, name, args });
    } catch (error) {
      this.subscriptions.delete(id);
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscriptions.delete(id);
      if (!this.closed) this.send({ type: "unsubscribe", id });
    };
  }

  private receive(event: Event): void {
    if (this.closed) return;
    if (event.type === "unsubscribed") return;
    const result = event.result;
    if (event.type === "response") {
      const pending = this.pending.get(event.id);
      if (pending) {
        this.pending.delete(event.id);
        if ("Ok" in result) pending.resolve(result.Ok);
        else pending.reject(new Error(result.Err));
        return;
      }
    }
    // Registration errors use response; query rerun errors use subscription.
    const observer = this.subscriptions.get(event.id);
    if (observer) {
      if (event.type === "response") this.subscriptions.delete(event.id);
      this.notify(
        observer,
        "Ok" in result ? { value: result.Ok } : { error: new Error(result.Err) },
      );
    }
  }

  private notify(observer: Observer, event: SubscriptionEvent<JsonValue>): void {
    // A throwing observer must not break stream processing and strand unrelated
    // calls, especially the mutation reply behind this update. Observers should
    // handle their own application failures; transport never retries callbacks.
    try {
      observer(event);
    } catch {
      /* isolate application callbacks */
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    this.unlisten();
    const observers = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    try {
      this.connection.close();
    } finally {
      for (const observer of observers) this.notify(observer, { error });
    }
  }

  close(): void {
    this.fail(new Error("client closed; mutation outcomes may be unknown"));
  }
}

// Structural subset accepted by browser and Bun WebSockets. Connection creation
// belongs to the caller; requiring OPEN avoids an unbounded pre-connect buffer.
export interface ClientWebSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(text: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "close" | "error", listener: () => void): void;
}

function decode(data: unknown): Event {
  if (typeof data !== "string") throw new Error("expected JSON text frame");
  const event: unknown = JSON.parse(data);
  assertJson(event, "server event");
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("invalid event");
  const { type, id, result } = event;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0)
    throw new Error("invalid event ID");
  if (type === "unsubscribed") return event as Event;
  if (
    (type !== "response" && type !== "subscription") ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  )
    throw new Error("invalid event result");
  if (
    Object.keys(result).length !== 1 ||
    (!("Ok" in result) && !("Err" in result && typeof result.Err === "string"))
  )
    throw new Error("invalid event outcome");
  return event as Event;
}

export class WebSocketTransport extends InProcessTransport {
  constructor(socket: ClientWebSocket) {
    if (socket.readyState !== 1) throw new Error("WebSocket must already be open");
    super({
      send(request) {
        const text = JSON.stringify(request);
        // Bound the SDK's socket queue as well as the server queues. A failed
        // send closes the whole connection; admitted mutation outcomes are unknown.
        if (text.length > 1024 * 1024 || socket.bufferedAmount > 1024 * 1024)
          throw new Error("WebSocket buffer capacity exceeded");
        socket.send(text);
      },
      listen(onEvent, onClose) {
        const message = (event: { data: unknown }) => {
          try {
            onEvent(decode(event.data));
          } catch (error) {
            onClose(error instanceof Error ? error : new Error(String(error)));
          }
        };
        const closed = () =>
          onClose(new Error("WebSocket closed; mutation outcomes may be unknown"));
        socket.addEventListener("message", message);
        socket.addEventListener("close", closed);
        socket.addEventListener("error", closed);
        return () => {
          socket.removeEventListener("message", message);
          socket.removeEventListener("close", closed);
          socket.removeEventListener("error", closed);
        };
      },
      close: () => socket.close(),
    });
  }
}
