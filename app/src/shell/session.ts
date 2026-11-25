import { isTauri } from "@tauri-apps/api/core";
import { LocalFunctions } from "../../../packages/runtime/js/local";
import { launchLocalWorker } from "../host/local";
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { TokamakClient, WebSocketTransport } from "@tokamak/sdk";
import { socketProtocols } from "../host/auth";
import { endpoint } from "../host/endpoint";
import { syncDisplayName } from "../host/identity";
import type { ServerEndpoint } from "../plugins/adapter";
import { createPluginShell, type PluginRouting, type PluginShell } from "../plugins/views";

// Matches DEVICE_SIGNED_OUT in packages/server/src/websocket.rs.
const DEVICE_SIGNED_OUT = 4001;

export type Connection =
  | { state: "connecting" }
  | { state: "connected"; client: TokamakClient; plugins: PluginShell; endpoint: ServerEndpoint }
  /** `token`: the server wants a (new) access token before it lets this window in. */
  | { state: "failed"; reason: string; needs?: "token" };

export interface Session {
  connection: Accessor<Connection>;
  retry(): void;
}

export interface SessionOptions {
  routing: PluginRouting;
  getEndpoint?: () => ServerEndpoint | Promise<ServerEndpoint>;
  /**
   * Which server the endpoint belongs to. When it changes, the session drops the old
   * connection (its socket and plugin UI) and connects to the new one.
   */
  server?: Accessor<string>;
  displayName?: () => string | undefined;
  /** Says why a connection failed when the server can tell more than the socket can. */
  explain?: (endpoint: ServerEndpoint) => Promise<{ reason: string; needs?: "token" } | undefined>;
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
    const workspaceKey = options.server?.();
    const displayName = options.displayName?.();
    const supplied = await (options.getEndpoint ?? endpoint)();
    if (current !== attempt) return;
    // An empty token is a server that needs one and has none saved; null needs none.
    if (supplied.token === "") {
      setConnection({ state: "failed", reason: "This server needs an access token.", needs: "token" });
      return;
    }
    const url = new URL(supplied.ws);
    const socket = new window.WebSocket(url, socketProtocols(supplied.token));
    close = () => socket.close();
    const timeout = setTimeout(() => socket.close(), 10_000);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener(
          "close",
          () => reject(new Error("The connection closed before it was ready.")),
          { once: true },
        );
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error(`No answer from ${url.host}.`)), {
          once: true,
        });
      });
      if (current !== attempt) return;
      const transport = new WebSocketTransport(socket);
      const local = isTauri()
        ? new LocalFunctions(transport, launchLocalWorker, url.origin + url.pathname)
        : undefined;
      const client = new TokamakClient(transport, local);
      const plugins = createPluginShell(client, supplied, transport, options.routing, workspaceKey);
      close = () => {
        void local?.close();
        plugins.dispose();
        transport.close();
      };
      let closed = false;
      socket.addEventListener("close", (event) => {
        closed = true;
        if (current !== attempt) return;
        void local?.close();
        plugins.dispose();
        setConnection(
          event.code === DEVICE_SIGNED_OUT
            ? { state: "failed", reason: "This device was signed out.", needs: "token" }
            : { state: "failed", reason: "The server closed the connection." },
        );
      });
      await syncDisplayName(supplied, displayName);
      if (current !== attempt || closed) return;
      await plugins.connect();
      // A socket that closed while the catalog loaded has already reported its failure.
      if (current === attempt && !closed)
        setConnection({ state: "connected", client, plugins, endpoint: supplied });
    } catch (cause) {
      socket.close();
      if (current !== attempt) return;
      const explained = await options.explain?.(supplied).catch(() => undefined);
      if (current === attempt) setConnection({ state: "failed", reason: message(cause), ...explained });
    } finally {
      clearTimeout(timeout);
    }
  }

  const retry = () => {
    void connect().catch((cause) => setConnection({ state: "failed", reason: message(cause) }));
  };
  if (options.server) createEffect(options.server, retry);
  else retry();
  onCleanup(disconnect);
  return { connection, retry };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
