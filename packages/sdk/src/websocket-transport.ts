import { isStructuredCallError } from "./call-error";
import type { MessageConnection } from "./transport";
import { MAX_WIRE_MESSAGE_BYTES } from "./protocol";
import type { Event } from "./protocol";
import { assertJson } from "./values";

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
  if (event.type === "pluginchanged") {
    validatePluginChange(event);
    return event as Event;
  }
  const { type, id, result } = event;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) throw new Error("invalid event ID");
  if (type === "unsubscribed") return event as Event;
  if (type !== "response" && type !== "subscription") throw new Error("invalid event result");
  validateResult(result);
  return event as Event;
}

function validatePluginChange(event: Record<string, unknown>): void {
  if (
    !Array.isArray(event.plugins) ||
    event.plugins.some((id) => typeof id !== "string") ||
    !event.catalog ||
    typeof event.catalog !== "object" ||
    Array.isArray(event.catalog)
  )
    throw new Error("invalid plugin change");
}

function validateResult(result: unknown): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid event result");
  if (
    Object.keys(result).length !== 1 ||
    (!("Ok" in result) &&
      !("Err" in result && (typeof result.Err === "string" || isStructuredCallError(result.Err))))
  )
    throw new Error("invalid event outcome");
}

export function webSocketConnection(socket: ClientWebSocket): MessageConnection {
  if (socket.readyState !== 1) throw new Error("WebSocket must already be open");
  return {
    send(request) {
      const text = JSON.stringify(request);
      // Bound the SDK's socket queue as well as the server queues. A failed
      // send closes the whole connection; admitted mutation outcomes are unknown.
      if (text.length > MAX_WIRE_MESSAGE_BYTES || socket.bufferedAmount > MAX_WIRE_MESSAGE_BYTES)
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
      const closed = () => onClose(new Error("WebSocket closed; mutation outcomes may be unknown"));
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
  };
}
