import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createApi, type FunctionReference } from "../../../sdk/src/api";
import { TokamakClient } from "../../../sdk/src/client";
import { WebSocketTransport } from "../../../sdk/src/transport";
import type { Id } from "../../../sdk/src/values";
import { CommandError, type Command } from "../command";
import { withServerEndpoint } from "../server";

type Agent = { plugin: string; backendId: string };
type OpenResult = {
  threadId: Id<"threads">;
  requestId: Id<"openRequests">;
  created: boolean;
  agent: Agent | null;
  folderRecorded: boolean;
  local: boolean;
};
const requests = createApi<{
  open: {
    request: FunctionReference<"action", { folder: string; alwaysNew: boolean }, OpenResult>;
    latest: FunctionReference<
      "query",
      {},
      { _id: Id<"openRequests">; threadId: Id<"threads">; shown: boolean } | null
    >;
  };
}>("chat").open;

async function connect(url: URL, token: string) {
  const ws = new URL("/ws", url);
  ws.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(ws, { headers: { Authorization: `Bearer ${token}` } });
  const signal = AbortSignal.timeout(5000);
  try {
    await new Promise<void>((ready, fail) => {
      socket.addEventListener("open", () => ready(), { once: true });
      socket.addEventListener("error", () => fail(new Error("Could not connect")), { once: true });
      signal.addEventListener("abort", () => fail(new Error("Connection timed out")), { once: true });
    });
    return new WebSocketTransport(socket);
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function waitForWindow(client: TokamakClient, requestId: OpenResult["requestId"]) {
  let stop: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>((done) => {
      timeout = setTimeout(() => done(false), 2000);
      stop = client.subscribe(requests.latest, {}, (event) => {
        if ("error" in event || event.value?._id !== requestId) done(false);
        else if (event.value.shown) done(true);
      });
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    stop?.();
  }
}

export default {
  path: "open",
  usesServer: true,
  summary:
    "Open a thread in a folder. Use --server <address> or TOKAMAK_SERVER with TOKAMAK_TOKEN for another server; saved names are only available in the window.",
  args: { name: "folder", optional: true },
  flags: { new: { summary: "Always create a new thread." } },
  example: "tokamak open . --json",
  async run([folderArg], { server, flags }) {
    const path = resolve(folderArg ?? ".");
    const folder = await realpath(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR")
        throw new CommandError(`Folder does not exist: ${path}`, "tokamak open --help");
      throw error;
    });
    if (!(await stat(folder)).isDirectory())
      throw new CommandError(`Not a folder: ${folder}`, "tokamak open --help");

    let transport: WebSocketTransport | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return withServerEndpoint(server, "open a thread", async (endpoint) => {
      try {
        transport = await connect(endpoint.url, endpoint.token);
        const client = new TokamakClient(transport);
        const connection = transport;
        timeout = setTimeout(() => connection.close(), 30_000);
        const { threadId, requestId, created, agent, folderRecorded, local } = await client.action(
          requests.request,
          {
            folder,
            alwaysNew: flags.new === true,
          },
        );
        clearTimeout(timeout);
        const windowConnected = await waitForWindow(client, requestId);
        let text = windowConnected
          ? `Opened thread ${threadId}.`
          : `Thread ${threadId} exists. Opening Tokamak on this server will show it.`;
        if (!local) text += " Choose an agent and folder in the window.";
        else if (!agent) text += " Choose an agent in the window.";
        return {
          data: {
            threadId,
            created,
            folder,
            server: endpoint.url.origin,
            windowConnected,
            agent,
            folderRecorded,
          },
          text,
        };
      } finally {
        clearTimeout(timeout);
        transport?.close();
      }
    });
  },
} satisfies Command;
