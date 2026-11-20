import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { direct, loopback } from "../../runtime/tools/direct-http";
import { CommandError } from "./command";
import { dataFolder } from "./data";
import { processIsAlive } from "./process";

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
  const health = discovery(await get("/health", endpoint));
  if (JSON.stringify(health) !== JSON.stringify(identity)) throw new Error("Local server identity changed");
  return endpoint;
}

async function get(path: string, endpoint: { url: URL; token: string }): Promise<unknown> {
  let response: Response;
  try {
    const url = new URL(path, endpoint.url);
    const headers = new Headers({ Authorization: `Bearer ${endpoint.token}` });
    const signal = AbortSignal.timeout(5000);
    response = loopback(url.hostname)
      ? await direct(url, headers, signal, {})
      : await fetch(url, { headers, signal, redirect: "error" });
  } catch {
    throw new Error("Could not connect to the server");
  }
  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("Server returned invalid JSON");
  }
}

export async function serverGet(path: string, explicit?: string): Promise<unknown> {
  const address = explicit ?? process.env.TOKAMAK_SERVER;
  if (!address) {
    const endpoint = await localEndpoint().catch(() => {
      throw new CommandError("No local server is running", "tokamak server start");
    });
    return get(path, endpoint).catch((error: Error) => {
      throw new CommandError(
        `Could not read ${path} from the local server: ${error.message}`,
        "tokamak server start",
      );
    });
  }
  try {
    const token = process.env.TOKAMAK_TOKEN;
    if (!token) throw new Error("Set TOKAMAK_TOKEN for the selected server");
    return await get(path, { url: httpAddress(address), token });
  } catch (error) {
    throw new CommandError(
      `Could not read ${path} from the selected server: ${error instanceof Error ? error.message : "Request failed"}`,
      "tokamak --help",
    );
  }
}
