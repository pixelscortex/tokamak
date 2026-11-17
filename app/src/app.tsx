import { createSignal, Show, For, onSettled } from "solid-js";
import { TokamakClient, WebSocketTransport } from "@tokamak/sdk";
import { Button } from "@ui-sdk/solid/button";
import { Input } from "@ui-sdk/solid/input";
import { api } from "./api";
import { useQuery } from "@tokamak/sdk/solid";
import { Controls } from "./controls";

type Session = { client: TokamakClient; close(): void };
export function App() {
  const [endpoint, setEndpoint] = createSignal("ws://127.0.0.1:43123/ws");
  const [session, setSession] = createSignal<Session | null>(null);
  const [status, setStatus] = createSignal("Disconnected");
  let pending: WebSocket | undefined;
  const disconnect = () => {
    pending?.close();
    pending = undefined;
    session()?.close();
    setSession(null);
    setStatus("Disconnected");
  };
  onSettled(() => disconnect);
  async function connect() {
    disconnect();
    const url = new URL(endpoint());
    if (
      url.protocol !== "ws:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/ws" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
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
          setSession(null);
        }
      });
      setSession({ client, close: () => transport.close() });
      setStatus("Connected to real Tokamak server");
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
