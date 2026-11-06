// Run with Bun after bundling ./feature. Two real independent connections use
// one SDK client implementation; the second observes the first client's commit.
import { TokamakClient, WebSocketTransport } from "../../sdk/src/index";
import { api } from "./feature/_generated/api";

const address = Bun.argv[2] ?? "ws://127.0.0.1:3000/ws";
async function connect() {
  const socket = new WebSocket(address);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket open failed")), {
      once: true,
    });
  });
  const transport = new WebSocketTransport(socket);
  return { client: new TokamakClient(transport), transport };
}

const first = await connect();
const second = await connect();
try {
  let initial!: () => void;
  const ready = new Promise<void>((resolve) => {
    initial = resolve;
  });
  let updated!: () => void;
  const live = new Promise<void>((resolve) => {
    updated = resolve;
  });
  const text = `headless demo ${Date.now()}`;
  const stop = second.client.subscribe(api.todos.list, {}, (event) => {
    if ("error" in event) {
      console.error(event.error);
      return;
    }
    console.log("client 2 live update:", event.value);
    initial();
    if (event.value.some((row) => row.text === text)) updated();
  });
  await ready;
  const id = await first.client.mutation(api.todos.add, { text });
  console.log("client 1 added:", id);
  console.log("client 1 list:", await first.client.query(api.todos.list, {}));
  await live;
  stop();
} finally {
  first.transport.close();
  second.transport.close();
}
