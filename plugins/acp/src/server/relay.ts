import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  action,
  RemoteFunctionError,
  threadPrompt,
  TokamakClient,
  v,
  WebSocketTransport,
  type ActionSignal,
} from "@tokamak/sdk";
import { api as chat } from "plugin:chat/server";
import { Agents } from "./agents/client";
import { checkFolder } from "./agents/discovery";
import { acpSend } from "./turn/acp";
import type { ChatPort } from "./turn/chat-port";

export const relayTurn = action({
  args: {
    hub: v.object({ http: v.string(), token: v.string() }),
    threadId: v.id("threads"),
    text: v.string(),
    backendId: v.string(),
    requestId: v.string(),
    cwd: v.optional(v.string()),
  },
  handler: async (ctx, { hub, threadId, text, backendId, requestId, cwd: folder }) => {
    const agents = new Agents();
    let origin: URL;
    let cwd: string;
    try {
      if (ctx.user.id !== "local")
        throw new Error("Agents run from the desktop app on your own computer.");
      origin = hubOrigin(hub.http);
      if (!hub.token || hub.token.length > 4096 || /[^\x21-\x7e]/.test(hub.token))
        throw new Error("Invalid hub access token");
      if (!agents.agents().some((agent) => agent.id === backendId))
        throw new Error("Agent not found on this computer");
      cwd = checkFolder({ path: folder ?? "" });
    } catch (error) {
      return { notStarted: String(error) };
    }
    const connection = hubConnection(origin, hub.token, ctx.signal);
    const call = connection.call;
    try {
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
      const started = await call(
        (client) =>
          client.mutation(chat.startRun, {
            threadId,
            text,
            token,
            relay: { backendId, requestId },
          }),
        true,
      ).catch((error) => {
        if (error instanceof ActiveRunError) return { notStarted: error.message };
        throw error;
      });
      if ("notStarted" in started) return started;
      if (!started.started) return started;
      const key = createHash("sha256")
        .update(JSON.stringify([origin.origin, threadId, started.owner.id, backendId, cwd]))
        .digest("hex");
      const path = `relay-${key}.session`;
      const sessionId = await readFile(path, "utf8").catch(() => undefined);
      let sequence = 0;
      const port: ChatPort = {
        updateRun: (args) => {
          const update = { ...args, sequence: ++sequence };
          return call((client) => client.mutation(chat.updateRun, update), true);
        },
        runIsRunning: (args) => call((client) => client.query(chat.runIsRunning, args)),
        requestPermission: (args) => call((client) => client.mutation(chat.requestPermission, args), true),
        permissionState: (args) => call((client) => client.query(chat.permissionState, args)),
        claimPermission: (args) => call((client) => client.mutation(chat.claimPermission, args), true),
        permissionUndelivered: (args) =>
          call((client) => client.mutation(chat.permissionUndelivered, args), true),
        async saveBackendState({ state }) {
          const pending = `${path}.${crypto.randomUUID()}`;
          await writeFile(pending, (state as { sessionId: string }).sessionId, { mode: 0o600 });
          await rename(pending, path);
          return null;
        },
      };
      return await acpSend(
        port,
        { threadId, text },
        { ...started, token },
        { agent: backendId, cwd, ...(sessionId ? { sessionId } : {}) },
        agents,
        ctx.signal,
        threadPrompt(started.history, text.trim(), started.owner),
      ).catch(() => ({
        runId: started.runId,
        messageId: started.messageId,
        status: "error" as const,
      }));
    } finally {
      connection.close();
      agents.close();
    }
  },
});

function hubOrigin(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid hub URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && /^(?:127\.\d+\.\d+\.\d+|\[::1\]|localhost)$/.test(url.hostname))
    )
  )
    throw new Error("Use an HTTPS hub URL (HTTP is allowed only on loopback)");
  return url;
}

// Bun's worker WebSocket accepts headers; the DOM type only declares subprotocols.
type WorkerSocket = new (url: URL, options: { headers: Record<string, string> }) => WebSocket;

class ActiveRunError extends Error {}

function hubConnection(origin: URL, token: string, signal: ActionSignal | undefined) {
  const url = new URL("/ws", origin);
  url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  let socket: WebSocket | undefined;
  let transport: WebSocketTransport | undefined;
  let client: TokamakClient | undefined;
  let deadline = Date.now() + 10_000;

  function close() {
    transport?.close();
    socket?.close();
    transport = socket = client = undefined;
  }
  async function connect() {
    const Socket = WebSocket as unknown as WorkerSocket;
    const opened = new Socket(url, { headers: { Authorization: `Bearer ${token}` } });
    socket = opened;
    await new Promise<void>((resolve, reject) => {
      opened.addEventListener("open", () => resolve(), { once: true });
      for (const type of ["close", "error"] as const)
        opened.addEventListener(type, () => reject(new Error("Hub connection closed")), { once: true });
    });
    if (socket !== opened) throw new Error("Hub connection retired");
    transport = new WebSocketTransport(opened);
    return (client = new TokamakClient(transport));
  }
  async function call<T>(operation: (client: TokamakClient) => Promise<T>, write = false): Promise<T> {
    while (!signal?.aborted && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort!: () => void;
      try {
        const bounded = new Promise<never>((_, reject) => {
          abort = () => reject(new Error("Hub call timed out or was cancelled"));
          signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(abort, Math.min(4_000, deadline - Date.now()));
        });
        const result = await Promise.race([(async () => operation(client ?? (await connect())))(), bounded]);
        if (write) deadline = Date.now() + 60_000;
        return result;
      } catch (error) {
        if (error instanceof RemoteFunctionError) {
          if (error.message.includes("Thread already has an active run"))
            throw new ActiveRunError("Thread already has an active run for this agent");
          throw new Error("The hub refused the turn update");
        }
        close();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
      if (!signal?.aborted) await delay(250);
    }
    throw new Error("Could not write to the hub; the local agent was stopped.");
  }
  return { call, close };
}
