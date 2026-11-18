import { createApi, TokamakClient, WebSocketTransport, type FunctionReference } from "@tokamak/sdk";

const api = createApi<{
  threads: {
    list: FunctionReference<"query", {}, { title: string }[]>;
    create: FunctionReference<"action", { title?: string }, string>;
  };
}>("chat");
const socket = new WebSocket("ws://127.0.0.1:43123/ws");
await new Promise<void>((resolve, reject) => {
  socket.onopen = () => resolve();
  socket.onerror = () => reject(new Error("WebSocket open failed"));
});
const transport = new WebSocketTransport(socket);
const client = new TokamakClient(transport);
const title = `Live SDK check ${Date.now()}`;
let updates = 0;
let found!: () => void;
let ready!: () => void;
const initial = new Promise<void>((resolve) => {
  ready = resolve;
});
const live = new Promise<void>((resolve) => {
  found = resolve;
});
const stop = client.subscribe(api.threads.list, {}, (event) => {
  if ("error" in event) throw event.error;
  updates++;
  ready();
  if (event.value.some((thread) => thread.title === title)) found();
});
try {
  await initial;
  const id = await client.action(api.threads.create, { title });
  await Promise.race([
    live,
    new Promise((_, reject) => setTimeout(() => reject(new Error("No live update")), 5000)),
  ]);
  console.log(JSON.stringify({ created: id, updates, live: true }));
} finally {
  stop();
  transport.close();
}
