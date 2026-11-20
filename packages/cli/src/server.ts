import {
  ConnectionError,
  type Endpoint,
  httpAddress,
  inspectLocalServer,
  json,
  loopback,
  request,
  type RequestOptions,
  ServerRequestError,
} from "../../runtime/tools/server-discovery";
import { CommandError } from "./command";
import { dataFolder } from "./data";

export { inspectLocalServer, readToken } from "../../runtime/tools/server-discovery";

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

function selectedEndpoint(explicit?: string): Endpoint | undefined {
  const address = explicit ?? process.env.TOKAMAK_SERVER;
  if (!address) return;
  const token = process.env.TOKAMAK_TOKEN;
  if (!token) throw new ServerRequestError("Set TOKAMAK_TOKEN for the selected server");
  const url = httpAddress(address);
  if (url.protocol === "http:" && !loopback(url.hostname))
    throw new ServerRequestError("Use HTTPS for a shared server");
  return { url, token };
}

function tokenRejection(response: Response) {
  return response.status === 401 ? new ServerRequestError("The server rejected the token") : undefined;
}

export class ServerRefusal extends CommandError {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message, "tokamak plugin list");
  }
}

async function pluginRequest(path: string, endpoint: Endpoint, body?: object, selected = false) {
  const response = await request(
    path,
    endpoint,
    body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {},
    body ? 30_000 : 5000,
  );
  const rejected = selected && tokenRejection(response);
  if (rejected) throw rejected;
  if (body && response.status >= 400 && response.status < 500 && response.status !== 408) {
    const result = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new ServerRefusal(
      typeof result?.error === "string" ? result.error : `Server refused reload (HTTP ${response.status})`,
      result?.code,
    );
  }
  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
  return json(response);
}

export function serverGetAt(path: string, endpoint: Endpoint) {
  return pluginRequest(path, endpoint);
}

export function serverGet(path: string, explicit?: string) {
  return serverRequest(path, explicit);
}

export function serverPost(path: string, body: object, explicit?: string) {
  return serverRequest(path, explicit, body);
}

async function serverRequest(path: string, explicit?: string, body?: object): Promise<unknown> {
  let endpoint: Endpoint | undefined;
  try {
    endpoint = selectedEndpoint(explicit);
    if (endpoint) return await pluginRequest(path, endpoint, body, true);
  } catch (error) {
    if (error instanceof ServerRefusal) throw error;
    throw new CommandError(
      `Could not read ${path} from the selected server: ${error instanceof Error ? error.message : "Request failed"}`,
      "tokamak --help",
    );
  }
  const local = await localEndpoint();
  return pluginRequest(path, local, body).catch((error: Error) => {
    if (error instanceof ServerRefusal) throw error;
    throw new CommandError(
      `Could not read ${path} from the local server: ${error.message}`,
      "tokamak server start",
    );
  });
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
  init?: RequestOptions,
) {
  const next = `tokamak ${operation} --help`;
  try {
    const endpoint = selectedEndpoint(explicit) ?? (await localEndpoint());
    const response = await request(path, endpoint, init);
    if (response.status === 403)
      throw new CommandError("Only the owner can manage members", "tokamak members --help");
    const rejected = tokenRejection(response);
    if (rejected) throw rejected;
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

export function sharingEndpoint(explicit: string | undefined, example: string): Endpoint {
  try {
    const endpoint = selectedEndpoint(explicit);
    if (endpoint) return endpoint;
    throw new ServerRequestError("Set --server or TOKAMAK_SERVER to select a server");
  } catch (error) {
    if (error instanceof ServerRequestError) throw new CommandError(error.message, example);
    throw error;
  }
}

export async function sharingRequest(path: string, endpoint: Endpoint, init?: RequestOptions) {
  const version = path === "/version";
  const response = version
    ? await request(path, { url: endpoint.url })
    : await request(path, endpoint, init, 30_000);
  if (response.ok) return json(response);

  const next = `tokamak plugin list --server ${endpoint.url.origin}`;
  const detail = await response.text();
  if (detail) {
    let reason = detail;
    try {
      const body = JSON.parse(detail) as { error?: unknown } | null;
      if (typeof body?.error === "string") reason = body.error;
    } catch {
      // A server may also send its reason as plain text.
    }
    throw new CommandError(reason, next);
  }
  const checkToken = `Use TOKAMAK_TOKEN with GET ${endpoint.url.origin}/account to check which account it belongs to`;
  const rejected = tokenRejection(response);
  if (rejected) throw new CommandError(rejected.message, checkToken);
  if (response.status === 403)
    throw new CommandError("Only the owner of this server can share or remove plugins", checkToken);
  throw new CommandError(`Server returned HTTP ${response.status}`, next);
}
