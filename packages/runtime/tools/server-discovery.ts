/** Authenticated local discovery shared by the CLI and plugin builder. */
import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { direct, loopback, type RequestOptions } from "./direct-http";
export type { RequestOptions } from "./direct-http";
export { loopback } from "./direct-http";
import { processIsAlive } from "./process";

export function httpAddress(address: string) {
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

export type Endpoint = { url: URL; token: string };

export class ServerRequestError extends Error {}
export class ConnectionError extends ServerRequestError {}

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
  const endpoint = { url: httpAddress(identity.url), token };
  try {
    const health = discovery(await get("/health", endpoint));
    if (JSON.stringify(health) !== JSON.stringify(identity)) throw new Error("Local server identity changed");
  } catch (error) {
    if (!(error instanceof ConnectionError)) throw error;
    return processIsAlive(identity.pid) ? { identity, responsive: false as const } : undefined;
  }
  return { identity, responsive: true as const, endpoint };
}

export async function request(
  path: string,
  endpoint: { url: URL; token?: string },
  init: RequestOptions = {},
  timeout = 5000,
) {
  const destination = new URL(path, endpoint.url);
  if (destination.origin !== endpoint.url.origin) throw new ServerRequestError("Invalid server route");
  const headers = new Headers(init.headers);
  if (endpoint.token) headers.set("Authorization", `Bearer ${endpoint.token}`);
  const signal = AbortSignal.timeout(timeout);
  try {
    if (loopback(destination.hostname)) return await direct(destination, headers, signal, init);
    return await fetch(destination, {
      ...init,
      headers,
      signal,
      redirect: "error",
    });
  } catch {
    throw new ConnectionError("Could not connect to the server");
  }
}

export async function json(response: Response): Promise<unknown> {
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

/** Read from the running local server after checking the process and health identity. */
export async function fetchLocal(folder: string, path: string) {
  const server = await inspectLocalServer(folder);
  if (server?.responsive) return request(path, server.endpoint, {}, 3000);
}
