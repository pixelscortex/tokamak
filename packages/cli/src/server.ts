import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { CommandError } from "./command";
import { dataFolder } from "./data";
import { processIsAlive } from "./process";

const loopback = (host: string) =>
  host === "localhost" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127."));
const noProxy = { proxy: "" };

function httpAddress(address: string) {
  let url: URL;
  try {
    url = new URL(address.includes("://") ? address : `http://${address}`);
  } catch {
    throw new Error("Invalid server address");
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Expected an HTTP or HTTPS server address without credentials");
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
    !processIsAlive(pid) ||
    typeof url !== "string" ||
    typeof bundleHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(bundleHash) ||
    !optionalString(buildId) ||
    !optionalString(pluginRoot)
  )
    throw new Error("Invalid local server identity");
  return { pid, url, bundleHash, buildId: buildId ?? null, pluginRoot: pluginRoot ?? null };
}

async function readToken(folder: string) {
  const file = join(folder, "server.token");
  const metadata = await lstat(file);
  if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0))
    throw new Error("Local server token must be a private regular file");
  const token = await readFile(file, "utf8");
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("Invalid local server token");
  return token;
}

async function localEndpoint() {
  const folder = dataFolder();
  const identity = discovery(JSON.parse(await readFile(join(folder, "server.json"), "utf8")));
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
  const token = await readToken(folder);
  const endpoint = { url: httpAddress(identity.url), token };
  const health = discovery(await request("/health", endpoint));
  if (JSON.stringify(health) !== JSON.stringify(identity)) throw new Error("Local server identity changed");
  return endpoint;
}

export class ServerRefusal extends CommandError {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message, "tokamak plugin list");
  }
}

async function request(path: string, endpoint: { url: URL; token: string }, body?: object): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, endpoint.url), {
      ...(loopback(endpoint.url.hostname) ? noProxy : {}),
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        ...(body && { "Content-Type": "application/json" }),
      },
      method: body ? "POST" : "GET",
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(body ? 30_000 : 5000),
      redirect: "error",
    });
  } catch {
    throw new Error("Could not connect to the server");
  }
  if (body && response.status >= 400 && response.status < 500 && response.status !== 408) {
    const result = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new ServerRefusal(
      typeof result?.error === "string" ? result.error : `Server refused reload (HTTP ${response.status})`,
      result?.code,
    );
  }
  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("Server returned invalid JSON");
  }
}

export function serverGet(path: string, explicit?: string) {
  return serverRequest(path, explicit);
}

export function serverPost(path: string, body: object, explicit?: string) {
  return serverRequest(path, explicit, body);
}

async function serverRequest(path: string, explicit?: string, body?: object): Promise<unknown> {
  const address = explicit ?? process.env.TOKAMAK_SERVER;
  if (!address) {
    const endpoint = await localEndpoint().catch(() => {
      throw new CommandError("No local server is running", "tokamak server start");
    });
    return request(path, endpoint, body).catch((error: Error) => {
      if (error instanceof ServerRefusal) throw error;
      throw new CommandError(
        `Could not read ${path} from the local server: ${error.message}`,
        "tokamak server start",
      );
    });
  }
  try {
    const token = process.env.TOKAMAK_TOKEN;
    if (!token) throw new Error("Set TOKAMAK_TOKEN for the selected server");
    return await request(path, { url: httpAddress(address), token }, body);
  } catch (error) {
    if (error instanceof ServerRefusal) throw error;
    throw new CommandError(
      `Could not read ${path} from the selected server: ${error instanceof Error ? error.message : "Request failed"}`,
      "tokamak --help",
    );
  }
}
