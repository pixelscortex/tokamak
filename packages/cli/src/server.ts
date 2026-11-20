import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { CommandError } from "./command";
import { dataFolder } from "./data";

function httpAddress(address: string) {
  const url = new URL(address.includes("://") ? address : `http://${address}`);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Expected an HTTP or HTTPS server address without credentials");
  return url;
}

async function localEndpoint() {
  const folder = dataFolder();
  const { url: address } = JSON.parse(await readFile(join(folder, "server.json"), "utf8"));
  const ws = new URL(address);
  if (
    ws.protocol !== "ws:" ||
    ws.pathname !== "/ws" ||
    ws.search ||
    ws.hash ||
    !(ws.hostname === "[::1]" || (isIP(ws.hostname) === 4 && ws.hostname.startsWith("127.")))
  )
    throw new Error("Invalid local server discovery address");
  const file = join(folder, "server.token");
  const metadata = await lstat(file);
  if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0))
    throw new Error("Local server token must be a private regular file");
  const token = await readFile(file, "utf8");
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("Invalid local server token");
  return { url: httpAddress(address), token };
}

export function serverGet(path: string, explicit?: string): Promise<unknown> {
  return serverRequest(path, explicit);
}

export function serverPost(path: string, body: object, explicit?: string): Promise<unknown> {
  return serverRequest(path, explicit, body);
}

/** A validated candidate was refused; the running installation is unchanged. */
export class ServerRefusal extends CommandError {}

async function serverRequest(path: string, explicit?: string, body?: object): Promise<unknown> {
  const address = explicit ?? process.env.TOKAMAK_SERVER;
  const next = address ? "tokamak --help" : "tokamak server start";
  try {
    const endpoint = address
      ? { url: httpAddress(address), token: process.env.TOKAMAK_TOKEN }
      : await localEndpoint();
    if (!endpoint.token) throw new Error("Set TOKAMAK_TOKEN for the selected server");
    const response = await fetch(new URL(path, endpoint.url), {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(body ? 120_000 : 5000),
      redirect: "error",
    });
    return await readResponse(response, body !== undefined);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    if (!address && (error as NodeJS.ErrnoException).code === "ENOENT")
      throw new CommandError("No local server is running", next);
    throw new CommandError(
      `Could not ${body ? "request" : "read"} ${path} from the ${address ? "selected server" : "local server"}: ${error instanceof Error ? error.message : String(error)}`,
      next,
    );
  }
}

async function readResponse(response: Response, isPost: boolean) {
  if (isPost && response.status === 400) {
    const result = await response.json();
    if (result && typeof result === "object" && "error" in result && typeof result.error === "string")
      throw new ServerRefusal(result.error, "tokamak plugin reload --help");
  }
  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
  return await response.json();
}
