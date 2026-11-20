import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { CommandError } from "./command";
import { dataFolder } from "./data";
import { processIsAlive } from "./process";

function httpAddress(address: string) {
  let url: URL;
  try {
    url = new URL(address.includes("://") ? address : `http://${address}`);
  } catch {
    throw new ServerRequestError("Invalid server address");
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new ServerRequestError("Expected an HTTP or HTTPS server address without credentials");
  return url;
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === "string";
}

function discovery(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid local server discovery");
  const { pid, url, bundleHash, buildId, pluginRoot } = value as Record<string, unknown>;
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid < 1 ||
    pid > 0x7fffffff ||
    typeof url !== "string" ||
    typeof bundleHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(bundleHash) ||
    !optionalString(buildId) ||
    !optionalString(pluginRoot)
  )
    throw new Error("Invalid local server identity");
  return { pid, url, bundleHash, buildId: buildId ?? null, pluginRoot: pluginRoot ?? null };
}

export async function readToken(folder: string) {
  const file = join(folder, "server.token");
  const metadata = await lstat(file);
  if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0))
    throw new Error("Local server token must be a private regular file");
  const token = await readFile(file, "utf8");
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("Invalid local server token");
  return token;
}

type Endpoint = { url: URL; token: string; direct?: boolean };

class ServerRequestError extends Error {}
class ConnectionError extends ServerRequestError {}
const noProxy = { proxy: "" };

export async function inspectLocalServer(folder: string) {
  const source = await readFile(join(folder, "server.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (source === undefined) return;
  const identity = discovery(JSON.parse(source));
  const ws = new URL(identity.url);
  if (
    ws.protocol !== "ws:" ||
    ws.username ||
    ws.password ||
    !identity.url.endsWith("/ws") ||
    ws.pathname !== "/ws" ||
    ws.search ||
    ws.hash ||
    !(ws.hostname === "[::1]" || (isIP(ws.hostname) === 4 && ws.hostname.startsWith("127.")))
  )
    throw new Error("Invalid local server discovery address");
  if (!processIsAlive(identity.pid)) return;
  const token = await readToken(folder);
  const endpoint = { url: httpAddress(identity.url), token, direct: true };
  try {
    const health = discovery(await get("/health", endpoint));
    if (JSON.stringify(health) !== JSON.stringify(identity)) throw new Error("Local server identity changed");
  } catch (error) {
    if (!(error instanceof ConnectionError)) throw error;
    return processIsAlive(identity.pid) ? { identity, responsive: false as const } : undefined;
  }
  return { identity, responsive: true as const, endpoint };
}

async function request(path: string, endpoint: Endpoint, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${endpoint.token}`);
  try {
    return await fetch(new URL(path, endpoint.url), {
      ...init,
      ...(endpoint.direct ? noProxy : {}),
      headers,
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
  } catch {
    throw new ConnectionError("Could not connect to the server");
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ServerRequestError("Server returned invalid JSON");
  }
}

async function get(path: string, endpoint: Endpoint) {
  const response = await request(path, endpoint);
  if (!response.ok) throw new ServerRequestError(`Server returned HTTP ${response.status}`);
  return json(response);
}

export async function requestShutdown(endpoint: Endpoint) {
  try {
    const response = await request("/shutdown", endpoint, { method: "POST" });
    if (!response.ok) throw new Error(`Local server shutdown refused (HTTP ${response.status})`);
  } catch (error) {
    // Shutdown can close HTTP I/O before replying. The caller waits for discovery removal.
    if (!(error instanceof ConnectionError)) throw error;
  }
}

async function localEndpoint() {
  const server = await inspectLocalServer(dataFolder()).catch(() => undefined);
  if (!server) throw new CommandError("No local server is running", "tokamak server start");
  if (!server.responsive)
    throw new CommandError("Local server is running but is not responding", "tokamak server status");
  return server.endpoint;
}

export async function serverGet(path: string, explicit?: string): Promise<unknown> {
  const address = explicit ?? process.env.TOKAMAK_SERVER;
  if (!address) {
    const endpoint = await localEndpoint();
    return get(path, endpoint).catch((error: Error) => {
      throw new CommandError(
        `Could not read ${path} from the local server: ${error.message}`,
        "tokamak server start",
      );
    });
  }
  try {
    const token = process.env.TOKAMAK_TOKEN;
    if (!token) throw new ServerRequestError("Set TOKAMAK_TOKEN for the selected server");
    return await get(path, { url: httpAddress(address), token });
  } catch (error) {
    throw new CommandError(
      `Could not read ${path} from the selected server: ${error instanceof Error ? error.message : "Request failed"}`,
      "tokamak --help",
    );
  }
}

const memberOperations = {
  invite: "create an invite",
  members: "list members",
  revoke: "revoke a member",
};

export async function memberRequest(
  operation: keyof typeof memberOperations,
  path: string,
  explicit?: string,
  init?: RequestInit,
) {
  const next = `tokamak ${operation} --help`;
  try {
    const address = explicit ?? process.env.TOKAMAK_SERVER;
    const endpoint = address
      ? { url: httpAddress(address), token: process.env.TOKAMAK_TOKEN }
      : await localEndpoint();
    const { hostname, protocol } = endpoint.url;
    if (
      protocol === "http:" &&
      !(
        hostname === "localhost" ||
        hostname === "[::1]" ||
        (isIP(hostname) === 4 && hostname.startsWith("127."))
      )
    )
      throw new ServerRequestError("Use HTTPS for a shared server");
    if (!endpoint.token) throw new ServerRequestError("Set TOKAMAK_TOKEN for the selected server");
    const response = await request(path, { ...endpoint, token: endpoint.token }, init);
    if (response.status === 403)
      throw new CommandError("Only the owner can manage members", "tokamak members --help");
    if (response.status === 401) throw new ServerRequestError("The server rejected the token");
    if (response.status === 400) {
      // Recognize known responses without displaying arbitrary server text.
      const detail = await response.text();
      if (operation === "revoke" && detail === "Unknown member")
        throw new CommandError("Unknown member", "tokamak members");
      if (operation === "revoke" && detail === "The bootstrap owner cannot be revoked")
        throw new CommandError("The owner cannot be revoked", "tokamak members");
      if (
        operation === "invite" &&
        detail === "Name must contain 1–100 characters without control characters"
      )
        throw new CommandError("Name must contain 1–100 characters without control characters", next);
    }
    if (!response.ok) throw new ServerRequestError(`Server returned HTTP ${response.status}`);
    return { body: await json(response), origin: endpoint.url.origin };
  } catch (error) {
    if (error instanceof CommandError) throw error;
    const message = error instanceof ServerRequestError ? error.message : "Request failed";
    throw new CommandError(`Could not ${memberOperations[operation]}: ${message}`, next);
  }
}
