import { createSignal, onCleanup, type Accessor } from "solid-js";
import { TokamakClient, WebSocketTransport } from "@tokamak/sdk";
import { endpoint, hosted } from "../host/endpoint";
import type { ServerEndpoint } from "../plugins/adapter";
import { createPluginShell, type PluginRouting, type PluginShell } from "../plugins/views";

export type Connection =
  | { state: "connecting" }
  | { state: "connected"; client: TokamakClient; plugins: PluginShell; endpoint: ServerEndpoint }
  | { state: "failed"; reason: string };

export interface Session {
  connection: Accessor<Connection>;
  retry(): void;
}

export interface SessionOptions {
  routing: PluginRouting;
  getEndpoint?: () => ServerEndpoint | Promise<ServerEndpoint>;
}

export function createSession(options: SessionOptions): Session {
  const [connection, setConnection] = createSignal<Connection>({ state: "connecting" }, { ownedWrite: true });
  let attempt = 0;
  let close = () => {};

  const disconnect = () => {
    attempt++;
    close();
    close = () => {};
  };

  async function connect() {
    disconnect();
    const current = attempt;
    setConnection({ state: "connecting" });
    const supplied = await (options.getEndpoint ?? endpoint)();
    if (current !== attempt) return;
    if (!options.getEndpoint && hosted() && !supplied.token) {
      setConnection({ state: "failed", reason: "Enter your access token to connect." });
      return;
    }
    const url = new URL(supplied.ws);
    if (supplied.token) url.searchParams.set("token", supplied.token);
    const socket = new window.WebSocket(url);
    close = () => socket.close();
    const timeout = setTimeout(() => socket.close(), 10_000);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener(
          "close",
          () => reject(new Error("The connection closed before it was ready.")),
          {
            once: true,
          },
        );
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error(`No answer from ${url.host}.`)), {
          once: true,
        });
      });
      if (current !== attempt) return;
      const transport = new WebSocketTransport(socket);
      const client = new TokamakClient(transport);
      const plugins = createPluginShell(client, supplied, transport, options.routing);
      close = () => {
        plugins.dispose();
        transport.close();
      };
      let closed = false;
      socket.addEventListener("close", () => {
        closed = true;
        if (current !== attempt) return;
        plugins.dispose();
        setConnection({ state: "failed", reason: "The server closed the connection." });
      });
      await plugins.connect();
      // A socket that closed while the catalog loaded has already reported its failure.
      if (current === attempt && !closed)
        setConnection({ state: "connected", client, plugins, endpoint: supplied });
    } catch (cause) {
      socket.close();
      if (current === attempt) setConnection({ state: "failed", reason: message(cause) });
    } finally {
      clearTimeout(timeout);
    }
  }

  const retry = () => {
    void connect().catch((cause) => setConnection({ state: "failed", reason: message(cause) }));
  };
  retry();
  onCleanup(disconnect);
  return { connection, retry };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
