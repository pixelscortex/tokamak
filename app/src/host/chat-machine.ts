import { createApi, TokamakClient, WebSocketTransport, type FunctionReference } from "@tokamak/sdk";
import type { ChatMachine, RemoteChat } from "@tokamak/sdk/client";
import { isTauri } from "@tauri-apps/api/core";
import type { Endpoint } from "./endpoint";

type Action<A, R> = FunctionReference<"action", A, R>;
const acp = createApi<{
  relay: {
    relayTurn: Action<Parameters<ChatMachine["send"]>[0] & { hub: { http: string; token: string } }, unknown>;
  };
  backend: { configure: Action<{ backendId: string; settings: { cwd: string } }, { cwd: string }> };
}>("acp");
const chat = createApi<{
  backends: { list: Action<{}, Awaited<ReturnType<ChatMachine["list"]>>> };
}>("chat");

export function remoteChat(hub: Endpoint, local?: () => Promise<Endpoint>): RemoteChat {
  if (!local || !hub.token || (isTauri() && /Windows/i.test(navigator.userAgent))) return { hub: hub.http };
  const token = hub.token;
  async function onMachine<T>(run: (client: TokamakClient) => Promise<T>): Promise<T> {
    let endpoint: Endpoint;
    try {
      endpoint = await local!();
    } catch {
      throw new Error("This Mac is not answering. You can still send messages without an agent.");
    }
    if (!endpoint.token) throw new Error("This Mac has no local access token.");
    const url = new URL(endpoint.ws);
    url.searchParams.set("token", endpoint.token);
    const socket = new WebSocket(url);
    let transport: WebSocketTransport | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const unavailable = () => reject(new Error("This Mac is not answering."));
        timer = setTimeout(unavailable, 4_000);
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("close", unavailable, { once: true });
        socket.addEventListener("error", unavailable, { once: true });
      });
      clearTimeout(timer);
      transport = new WebSocketTransport(socket);
      return await run(new TokamakClient(transport));
    } finally {
      clearTimeout(timer);
      if (transport) transport.close();
      else socket.close();
    }
  }
  return {
    hub: hub.http,
    machine: {
      list: () =>
        onMachine(async (client) =>
          (await client.action(chat.backends.list, {})).filter((agent) => agent.plugin === "acp"),
        ),
      configure: (backendId, cwd) =>
        onMachine(
          async (client) =>
            (await client.action(acp.backend.configure, { backendId, settings: { cwd } })).cwd,
        ),
      send: (args) =>
        onMachine((client) =>
          client.action(acp.relay.relayTurn, { ...args, hub: { http: hub.http, token } }),
        ),
    },
  };
}
