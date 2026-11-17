import { createSignal, Show, For, onSettled } from "solid-js";
import { TokamakClient, WebSocketTransport } from "@tokamak/sdk";
import { Button } from "@ui-sdk/solid/button";
import { Input } from "@ui-sdk/solid/input";
import { api, websocketEndpoint } from "./api";
import { useQuery } from "@tokamak/sdk/solid";
import { Controls } from "./controls";

type Session = { client: TokamakClient; close(): void };
export function App() {
  const [session, setSession] = createSignal<Session | null>(null);
  const [status, setStatus] = createSignal("Disconnected");
  let pending: WebSocket | undefined;
  let attempt = 0;
  const disconnect = () => {
    attempt++;
    pending?.close();
    pending = undefined;
    session()?.close();
    setSession(null);
    setStatus("Disconnected");
  };
  onSettled(() => disconnect);
  async function connect() {
    disconnect();
    const current = attempt;
    setStatus("Connecting…");
    const url = await websocketEndpoint();
    if (current !== attempt) return;
    const socket = (pending = new WebSocket(url));
    const timeout = setTimeout(() => socket.close(), 10_000);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("close", () => reject(new Error("Connection closed before ready")), {
          once: true,
        });
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Cannot reach the Tokamak server")), {
          once: true,
        });
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
      if (current === attempt) setStatus(String(cause));
      socket.close();
    } finally {
      clearTimeout(timeout);
    }
  }
  onSettled(() => {
    void connect().catch((cause) => setStatus(String(cause)));
  });
  return (
    <div>
      <section class="connection card">
        <Show when={!session()}>
          <Button onClick={() => connect().catch((cause) => setStatus(String(cause)))}>Retry</Button>
        </Show>
        <p role="status" aria-label="Connection status">
          {status()}
        </p>
      </section>
      <Show when={session()} fallback={<p class="muted">Waiting for the Tokamak server.</p>}>
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
