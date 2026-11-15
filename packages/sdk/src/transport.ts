// Correlation and subscription lifecycle are shared by both transports. Hosts
// provide an ordered native message connection or an already-open WebSocket;
// this module installs no browser/Node globals. Only immutable catalog transfers
// may restart; queries, mutations and actions are never automatically retried.
import { webSocketConnection, type ClientWebSocket } from "./websocket-transport";
import type { ClientTransport, SubscriptionEvent } from "./client";
import type { Event, Request } from "./protocol";
import { MAX_WIRE_MESSAGE_BYTES } from "./protocol";
import type { JsonValue } from "./values";

export interface MessageConnection {
  send(request: Request): void;
  listen(onEvent: (event: Event) => void, onClose: (error?: Error) => void): () => void;
  close(): void;
}

type Pending = { resolve(value: JsonValue): void; reject(error: Error): void };
type Observer = (event: SubscriptionEvent<JsonValue>) => void;
// Per-connection admission budget, not a catalog/plugin quota. Correlation and
// live observers must remain resident until settlement; paging their state
// would lose ordered outcomes. Catalog/assets use one sequential call per page.
const CAPACITY = 128;
class CatalogRevisionChanged extends Error {
  constructor() { super("Plugin generation changed during catalog transfer"); }
}

function isCatalogPage(value: { [key: string]: JsonValue }, offset: number): value is { text: string; revision: string; done: boolean; next: number } {
  return typeof value.text === "string" && typeof value.revision === "string" && typeof value.done === "boolean"
    && typeof value.next === "number" && Number.isSafeInteger(value.next) && value.next >= offset
    && (value.done || value.next !== offset);
}

export class InProcessTransport implements ClientTransport {
  private next = 0;
  private closed: Error | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Map<number, Observer>();
  private readonly pluginListeners = new Set<(event: Extract<Event, { type: "pluginchanged" }>) => void>();
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

  action(name: string, args: JsonValue): Promise<JsonValue> {
    return this.call("action", name, args);
  }

  async plugins(): Promise<JsonValue> {
    // A reload may retire any page already in flight. Discard the whole partial
    // transfer and pin a fresh first page, with bounded retries under churn.
    // Pages from different snapshots cannot be combined; endless churn must
    // surface as a transient generation error rather than spin forever.
    for (let attempt = 0; ; attempt++) {
      try { return await this.catalog(); }
      catch (error) {
        if (attempt >= 2 || !(error instanceof CatalogRevisionChanged
          || error instanceof Error && error.message === "Plugin generation changed")) throw error;
      }
    }
  }

  private async catalog(): Promise<JsonValue> {
    let value = await this.control(id => ({ type: "plugins", id }));
    const chunks: string[] = [];
    let offset = 0;
    let revision: string | undefined;
    for (;;) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid catalog page");
      // Accept older hosts and structural test transports with a full catalog.
      if (Array.isArray(value.plugins)) {
        if (revision !== undefined) throw new CatalogRevisionChanged();
        return value;
      }
      if (!isCatalogPage(value, offset)) throw new Error("Invalid catalog page");
      if (revision === undefined) revision = value.revision;
      else if (value.revision !== revision) throw new CatalogRevisionChanged();
      chunks.push(value.text);
      if (value.done) {
        const assembled = JSON.parse(chunks.join("")) as JsonValue;
        if (!assembled || typeof assembled !== "object" || Array.isArray(assembled)
          || assembled.revision !== revision) throw new CatalogRevisionChanged();
        return assembled;
      }
      offset = value.next;
      const pinned = revision;
      value = await this.control(id => ({ type: "pluginspage", id, revision: pinned, offset }));
    }
  }

  async pluginAsset(plugin: string, name: string, revision: string): Promise<string> {
    let offset = 0;
    const chunks: string[] = [];
    for (;;) {
      const value = await this.control(id => ({ type: "pluginasset", id, plugin, name, revision, offset }));
      if (!value || typeof value !== "object" || Array.isArray(value)
        || typeof value.text !== "string" || typeof value.next !== "number"
        || typeof value.done !== "boolean" || !Number.isSafeInteger(value.next)
        || value.next < offset || (!value.done && value.next === offset)) throw new Error("Invalid plugin asset chunk");
      chunks.push(value.text);
      offset = value.next;
      if (value.done) return chunks.join("");
    }
  }

  onPluginsChanged(listener: (event: Extract<Event, { type: "pluginchanged" }>) => void): () => void {
    this.pluginListeners.add(listener);
    return () => { this.pluginListeners.delete(listener); };
  }

  private control(request: (id: number) => Request): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      if (this.pending.size >= CAPACITY) throw new Error("client call capacity exceeded");
      const id = this.id();
      this.pending.set(id, { resolve, reject });
      this.send(request(id));
    });
  }

  private id(): number {
    if (this.closed) throw this.closed;
    // IDs must remain exact across JSON numbers and native u64 correlation;
    // paging cannot extend one numeric identifier beyond that representation.
    if (this.next === Number.MAX_SAFE_INTEGER) throw new Error("request IDs exhausted");
    return ++this.next;
  }

  private send(request: Request): void {
    if (this.closed) throw this.closed;
    // Reject only this operation before admission. UTF-8, not JS code units,
    // determines the native/WebSocket message size (QuickJS has no TextEncoder).
    const text = JSON.stringify(request);
    let bytes = 0;
    for (const char of text) {
      const code = char.codePointAt(0)!;
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    // A data invocation is one atomic JSON value under the existing protocol;
    // splitting it would change admission/transaction semantics. Plugin catalog
    // and asset transfers already page around this per-message bound.
    if (bytes > MAX_WIRE_MESSAGE_BYTES) {
      const error = new Error("request too large (1 MiB limit)");
      this.pending.get(request.id)?.reject(error);
      this.pending.delete(request.id);
      this.subscriptions.delete(request.id);
      throw error;
    }
    try {
      this.connection.send(request);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.fail(failure);
      throw failure;
    }
  }

  private call(type: "query" | "mutation" | "action", name: string, args: JsonValue): Promise<JsonValue> {
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
      if (!this.closed) {
        try {
          this.send({ type: "unsubscribe", id });
        } catch {
          // send already failed/closed the stream and rejected pending calls.
          // Disposal must remain safe when native retirement races this send,
          // otherwise one cleanup failure can strand other Solid subscriptions.
        }
      }
    };
  }

  private receive(event: Event): void {
    if (this.closed) return;
    if (event.type === "pluginchanged") {
      for (const listener of this.pluginListeners) {
        try { listener(event); } catch { /* isolate window/plugin observers */ }
      }
      return;
    }
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
        "Ok" in result ? { value: result.Ok } : { error: new Error(result.Err), terminal: event.type === "response" },
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
    this.pluginListeners.clear();
    const observers = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    try {
      this.connection.close();
    } finally {
      for (const observer of observers) this.notify(observer, { error, terminal: true });
    }
  }

  close(): void {
    this.fail(new Error("client closed; mutation outcomes may be unknown"));
  }
}

export class WebSocketTransport extends InProcessTransport {
  constructor(socket: ClientWebSocket) {
    super(webSocketConnection(socket));
  }
}
export type { ClientWebSocket } from "./websocket-transport";
