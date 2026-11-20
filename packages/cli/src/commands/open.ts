import { realpath, stat } from "node:fs/promises";
import { createApi, type FunctionReference } from "../../../sdk/src/api";
import { TokamakClient } from "../../../sdk/src/client";
import { WebSocketTransport } from "../../../sdk/src/transport";
import type { Id } from "../../../sdk/src/values";
import { CommandError, type Command } from "../command";
import { matchesLocalServer, withServerEndpoint } from "../server";

type Agent = { plugin: string; backendId: string };
type OpenResult = {
  threadId: Id<"threads">;
  requestId: Id<"openRequests">;
  created: boolean;
  agent: Agent | null;
  folderRecorded: boolean;
  local: boolean;
};
type Shown = "acknowledged" | "pending" | "replaced";
const requests = createApi<{
  open: {
    request: FunctionReference<"action", { folder?: string; alwaysNew?: boolean }, OpenResult>;
    status: FunctionReference<"query", { requestId: OpenResult["requestId"] }, Shown>;
  };
}>("chat").open;
const account = createApi<{
  tokamak: { whoami: FunctionReference<"query", {}, { id: string }> };
}>().tokamak;

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

export async function waitForWindow(
  client: TokamakClient,
  requestId: OpenResult["requestId"],
  timeoutMs = 2000,
): Promise<Shown> {
  let stop: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Shown>((done) => {
      timeout = setTimeout(() => done("pending"), timeoutMs);
      stop = client.subscribe(requests.status, { requestId }, (event) => {
        if ("error" in event) done("pending");
        else if (event.value !== "pending") done(event.value);
      });
    });
  } catch {
    return "pending";
  } finally {
    clearTimeout(timeout);
    stop?.();
  }
}

export default {
  path: "open",
  usesServer: true,
  summary:
    "Open a thread in a folder. Only an explicitly set folder counts for reuse; the agent’s default home does not. Use --server <address> or TOKAMAK_SERVER with TOKAMAK_TOKEN for another server; saved names are only available in the window.",
  args: { name: "folder", optional: true },
  flags: { new: { summary: "Always create a new thread." } },
  example: "tokamak open . --json",
  async run([folderArg], { server, flags }) {
    const path = folderArg ?? ".";
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
        const localEndpoint = endpoint.local || (await matchesLocalServer(endpoint.url));
        transport = await connect(endpoint.url, endpoint.token);
        const client = new TokamakClient(transport);
        const connection = transport;
        timeout = setTimeout(() => connection.close(), 30_000);
        const user = await client.query(account.whoami, {});
        const isLocal = user.id === "local" && localEndpoint;
        const { threadId, requestId, created, agent, folderRecorded, local } = await client.action(
          requests.request,
          isLocal ? { folder, alwaysNew: flags.new === true } : {},
        );
        clearTimeout(timeout);
        const shown = await waitForWindow(client, requestId);
        const windowConnected = shown === "acknowledged";
        let text = local
          ? `Thread ${threadId} exists.`
          : `Created thread ${threadId} on a shared server. Every member can see it. Since the folder was not recorded, running this command again creates another thread. Choose an agent and folder in the window.`;
        if (shown === "acknowledged") text += " A window showed it.";
        else if (shown === "replaced") text += " A newer request replaced the request to show it.";
        else
          text +=
            " The request is pending; a window that opens within 5 minutes will show it if it is still pending.";
        if (local && !agent) text += " Choose an agent in the window.";
        return {
          data: {
            threadId,
            created,
            folder,
            server: endpoint.url.origin,
            windowConnected,
            shown,
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
