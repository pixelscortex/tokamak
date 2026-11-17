import { createSignal, Show, For, onSettled } from "solid-js";
import { TokamakClient, WebSocketTransport } from "@tokamak/sdk";
import { Button } from "@ui-sdk/solid/button";
import { Input } from "@ui-sdk/solid/input";
import { api } from "./api";
import { useQuery } from "@tokamak/sdk/solid";
import { Controls } from "./controls";

import type { ServerEndpoint } from "./plugins/adapter";
import { createPluginShell, type PluginRouting, type PluginShell } from "./plugins/views";

type Session = { client: TokamakClient; plugins?: PluginShell; close(): void };
export function App(
  props: { routing?: PluginRouting; getEndpoint?: () => ServerEndpoint | Promise<ServerEndpoint> } = {},
) {
  const [endpoint, setEndpoint] = createSignal("ws://127.0.0.1:43123/ws");
  const [session, setSession] = createSignal<Session | null>(null);
  const [status, setStatus] = createSignal("Disconnected");
  let pending: WebSocket | undefined;
  let connectionAttempt = 0;
  const disconnect = () => {
    connectionAttempt++;
    pending?.close();
    pending = undefined;
    session()?.close();
    setSession(null);
    setStatus("Disconnected");
  };
  onSettled(() => disconnect);
  async function connect() {
    disconnect();
    const attempt = connectionAttempt;
    const supplied = await props.getEndpoint?.();
    if (attempt !== connectionAttempt) return;
    const url = new URL(supplied?.ws ?? endpoint());
    if (
      !supplied &&
      (url.protocol !== "ws:" ||
        url.hostname !== "127.0.0.1" ||
        url.pathname !== "/ws" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password)
    ) {
      setStatus("Use a ws://127.0.0.1:port/ws development endpoint");
      return;
    }
    setStatus("Connecting…");
    const socket = (pending = new WebSocket(url));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
          "error",
          () => reject(new Error("Connection refused; check the disposable server")),
          { once: true },
        );
      });
      if (pending !== socket) return;
      const transport = new WebSocketTransport(socket);
      const client = new TokamakClient(transport);
      socket.addEventListener("close", () => {
        if (pending === socket) {
          setStatus("Connection closed; mutation outcomes may be unknown");
          session()?.plugins?.dispose();
          setSession(null);
        }
      });
      const http = new URL(url);
      http.protocol = "http:";
      http.pathname = "/";
      const plugins =
        props.routing &&
        createPluginShell(
          client,
          supplied ?? { http: http.href, ws: url.href, token: null },
          transport,
          props.routing,
        );
      setSession({
        client,
        plugins,
        close: () => {
          plugins?.dispose();
          transport.close();
        },
      });
      await plugins?.connect();
      if (pending === socket) setStatus("Connected to real Tokamak server");
    } catch (cause) {
      setStatus(String(cause));
      socket.close();
    }
  }
  return (
    <div>
      <section class="connection card">
        <label for="endpoint">Server WebSocket</label>
        <Input id="endpoint" value={endpoint()} onValueChange={setEndpoint} />
        <Button onClick={() => connect().catch((cause) => setStatus(String(cause)))}>Connect</Button>
        <p role="status" aria-label="Connection status">
          {status()}
        </p>
      </section>
      <Show
        when={session()}
        fallback={<p class="muted">Start the isolated server, then connect. The UI kit works offline.</p>}
      >
        {(active) => <Chat session={active()} disconnect={disconnect} />}
      </Show>
      <nav aria-label="Plugin views">
        <For each={session()?.plugins?.views() ?? []}>
          {(view) => (
            <a
              href={view.route}
              onClick={(event) => {
                event.preventDefault();
                session()?.plugins?.navigation.navigate(view.route);
              }}
            >
              {view.title}
            </a>
          )}
        </For>
      </nav>
      <Show when={!session()}>
        <Controls onNew={() => setStatus("Connect before creating a thread")} onDisconnect={disconnect} />
      </Show>
    </div>
  );
}
function Chat(props: { session: Session; disconnect(): void }) {
  const threads = useQuery(props.session.client, api.threads.list, () => ({}));
  const [title, setTitle] = createSignal("New thread");
  const [error, setError] = createSignal("");
  async function create() {
    setError("");
    try {
      await props.session.client.action(api.threads.create, { title: title() });
    } catch (cause) {
      setError(String(cause));
    }
  }
  return (
    <section class="stage">
      <Controls onNew={() => void create()} onDisconnect={props.disconnect} />
      <div class="create">
        <Input aria-label="New thread title" value={title()} onValueChange={setTitle} />
        <Button onClick={create}>New thread</Button>
      </div>
      <p role="status" aria-label="Live thread count">
        {threads.loading() ? "Loading threads…" : `${threads.data()?.length ?? 0} live threads`}
      </p>
      <Show when={threads.error()}>{(cause) => <p role="alert">{cause().message}</p>}</Show>
      <div class="chat-grid">
        <ul class="thread-list">
          <For each={threads.data() ?? []}>{(thread) => <li>{thread.title}</li>}</For>
        </ul>
      </div>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </section>
  );
}
