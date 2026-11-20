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

export async function serverRequest(
  path: string,
  explicit?: string,
  request: RequestInit = {},
  ownerOnly = false,
): Promise<{ body: unknown; origin: string }> {
  const address = explicit ?? process.env.TOKAMAK_SERVER;
  const next = address ? "tokamak --help" : "tokamak server start";
  try {
    const endpoint = address
      ? { url: httpAddress(address), token: process.env.TOKAMAK_TOKEN }
      : await localEndpoint();
    const { protocol, hostname } = endpoint.url;
    if (
      ownerOnly &&
      protocol === "http:" &&
      !(
        hostname === "localhost" ||
        hostname === "[::1]" ||
        (isIP(hostname) === 4 && hostname.startsWith("127."))
      )
    )
      throw new Error("Use HTTPS for a shared server");
    if (!endpoint.token) throw new Error("Set TOKAMAK_TOKEN for the selected server");
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${endpoint.token}`);
    const direct = address ? {} : { proxy: "" };
    const response = await fetch(new URL(path, endpoint.url), {
      ...request,
      ...direct,
      headers,
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (ownerOnly && response.status === 403)
      throw new CommandError("Only the owner can manage members", "tokamak members --help");
    if (!response.ok) {
      const detail = ownerOnly && response.status === 400 ? await response.text() : "";
      throw new Error(detail || `Server returned HTTP ${response.status}`);
    }
    return { body: await response.json(), origin: endpoint.url.origin };
  } catch (error) {
    if (error instanceof CommandError) throw error;
    if (!address && (error as NodeJS.ErrnoException).code === "ENOENT")
      throw new CommandError("No local server is running", next);
    throw new CommandError(
      `Could not read ${path} from the ${address ? "selected server" : "local server"}: ${error instanceof Error ? error.message : String(error)}`,
      next,
    );
  }
}

export async function serverGet(path: string, explicit?: string): Promise<unknown> {
  return (await serverRequest(path, explicit)).body;
}
