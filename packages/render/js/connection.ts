/** The native MessageConnection is structural: the SDK owns correlation and
 * promises, while the UI thread owns these callbacks for the document lifetime.
 * A null outbound message closes admission; accepted writes are never retried. */
import { onCleanup } from "solid-js";
import { onHostEvent } from "./index";

declare const __tokamakSend: (message: string) => void;

let connected = false;

export function createMessageConnection<TRequest, TEvent>() {
  // A document has one native session stream/ID space, not a broadcast bus of
  // independently correlated clients. A replacement needs a new document.
  if (connected) throw new Error("native document already has a connection");
  connected = true;
  let closed = false;
  let listener: ((event: TEvent) => void) | undefined;
  let closer: ((error?: Error) => void) | undefined;
  let reason: Error | undefined;

  function close(
    error = new Error("native connection closed; mutation outcomes may be unknown"),
  ) {
    if (closed) return;
    closed = true;
    reason = error;
    const notify = closer;
    listener = undefined;
    closer = undefined;
    try {
      __tokamakSend("null");
    } catch {
      // Closing is idempotent even after native admission has already retired.
      // The app owner independently joins the backend's graceful drain.
    } finally {
      notify?.(error);
    }
  }

  onHostEvent<TEvent>("connection:event", (event) => listener?.(event));
  onHostEvent<string>("connection:close", (message) => close(new Error(message)));
  onCleanup(close);

  return {
    send(request: TRequest): void {
      if (closed) throw reason;
      __tokamakSend(JSON.stringify(request));
    },
    listen(onEvent: (event: TEvent) => void, onClose: (error?: Error) => void) {
      if (closed) {
        onClose(reason);
        return () => {};
      }
      if (listener) throw new Error("native connection already has a listener");
      listener = onEvent;
      closer = onClose;
      return () => {
        listener = undefined;
        closer = undefined;
      };
    },
    close,
  };
}
