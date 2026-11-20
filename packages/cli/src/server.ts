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

export async function serverEndpoint(address?: string) {
  if (!address) return localEndpoint();
  const token = process.env.TOKAMAK_TOKEN;
  if (!token) throw new Error("Set TOKAMAK_TOKEN for the selected server");
  return { url: httpAddress(address), token };
}

export function serverFailure(error: unknown, address: string | undefined, operation: string) {
  const next = address ? "tokamak --help" : "tokamak server start";
  if (!address && (error as NodeJS.ErrnoException).code === "ENOENT")
    return new CommandError("No local server is running", next);
  return new CommandError(
    `Could not ${operation} from the ${address ? "selected server" : "local server"}: ${error instanceof Error ? error.message : String(error)}`,
    next,
  );
}

export async function serverGet(path: string, explicit?: string): Promise<unknown> {
  const address = explicit ?? process.env.TOKAMAK_SERVER;
  try {
    const endpoint = await serverEndpoint(address);
    const response = await fetch(new URL(path, endpoint.url), {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    throw serverFailure(error, address, `read ${path}`);
  }
}
