/** Local process ownership only; the server owns storage and shutdown. */
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { link, lstat, mkdir, open, readFile, rm, realpath, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { Readable } from "node:stream";
import { resolve } from "node:path";

export type Identity = {
  pid: number;
  url: string;
  bundleHash: string;
  pluginRoot?: string | null;
  buildId?: string | null;
};

export function localDirectory(binary: string, cwd = process.cwd()): string {
  const result = spawnSync(binary, ["--local-path"], {
    cwd,
    encoding: "utf8",
    windowsHide: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Cannot discover local server directory");
  return resolve(cwd, result.stdout.trim());
}

async function token(directory: string): Promise<string> {
  const path = resolve(directory, "server.token");
  const metadata = await lstat(path);
  if (!metadata.isFile() || (process.platform !== "win32" && metadata.mode & 0o077)) {
    throw new Error("Local capability must be a private regular file");
  }
  const value = await readFile(path, "utf8");
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Invalid local capability");
  return value;
}

function endpoint(identity: Identity, path: string): URL {
  const url = new URL(identity.url);
  if (
    url.protocol !== "ws:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/ws" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid local server discovery");
  }
  url.protocol = "http:";
  url.pathname = path;
  return url;
}

// A one-use HTTP connection cannot inherit an environment proxy or follow a redirect.
function direct(url: URL, capability: string, timeout: number, method = "GET"): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        agent: false,
        method,
        signal: AbortSignal.timeout(timeout),
        headers: { authorization: `Bearer ${capability}` },
      },
      (incoming) => {
        const code = incoming.statusCode ?? 500;
        const bodyless = code === 204 || code === 205 || code === 304;
        if (bodyless) incoming.resume();
        resolve(
          new Response(bodyless ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
            status: code,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function identityFields(identity: Identity) {
  return (
    identity &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    identity.pid <= 0x7fff_ffff &&
    typeof identity.url === "string" &&
    typeof identity.bundleHash === "string" &&
    /^[a-f0-9]{64}$/i.test(identity.bundleHash) &&
    (identity.pluginRoot === null ||
      identity.pluginRoot === undefined ||
      typeof identity.pluginRoot === "string") &&
    (identity.buildId === null || identity.buildId === undefined || typeof identity.buildId === "string")
  );
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export async function status(directory: string): Promise<Identity | undefined> {
  let identity: Identity;
  try {
    identity = JSON.parse(await readFile(resolve(directory, "server.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!identityFields(identity)) throw new Error("Invalid local server discovery");
  const url = endpoint(identity, "/health");
  if (!alive(identity.pid)) return;
  const capability = await token(directory);
  let response: Response;
  try {
    response = await direct(url, capability, 1000);
  } catch {
    return;
  }
  if (!response.ok) throw new Error(`Local server health refused (${response.status})`);
  const actual = (await response.json()) as Identity;
  if (
    !identityFields(actual) ||
    actual.pid !== identity.pid ||
    actual.url !== identity.url ||
    actual.bundleHash !== identity.bundleHash ||
    (actual.pluginRoot ?? null) !== (identity.pluginRoot ?? null) ||
    (actual.buildId ?? null) !== (identity.buildId ?? null)
  ) {
    throw new Error("Local server identity does not match discovery");
  }
  return identity;
}

/** Read an HTTP resource from the local server identified by the desktop app's
 * discovery and capability files. Never forward the capability on a redirect. */
export async function fetchLocal(directory: string, path: string): Promise<Response | undefined> {
  const identity = await status(directory);
  if (!identity) return;
  return direct(endpoint(identity, path), await token(directory), 3000);
}

async function wait(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

export async function ensure(
  binary: string,
  bundle: string,
  directory: string,
  mode: "bundle" | "plugins" = "bundle",
): Promise<Identity> {
  const pluginRoot = mode === "plugins" ? await realpath(bundle) : undefined;
  const hash =
    mode === "bundle"
      ? createHash("sha256")
          .update(await readFile(bundle))
          .digest("hex")
      : undefined;
  function compatible(identity: Identity): Identity {
    if (mode === "plugins" ? identity.pluginRoot !== pluginRoot : identity.bundleHash !== hash) {
      throw new Error(
        "Local server has a different backend bundle or plugin installation; run `bun run server:stop` first",
      );
    }
    return identity;
  }
  const running = await status(directory);
  if (running) return compatible(running);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = resolve(directory, "server-start.lock");
  // Serialize launchers, not the actual server. A crashed launcher's stale lock
  // produces an explicit error; never kill a PID or silently steal ownership.
  let owner = false;
  const deadline = Date.now() + 20_000;
  while (!owner && Date.now() < deadline) {
    try {
      await mkdir(lock, { mode: 0o700 });
      owner = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const running = await status(directory);
      if (running) return compatible(running);
      await wait();
    }
  }
  if (!owner) throw new Error("Local server startup lock is busy or stale; inspect server-start.lock");
  try {
    const running = await status(directory);
    if (running) return compatible(running);
    await createToken(directory);
    await token(directory);
    return compatible(await startServer(binary, bundle, directory, mode, deadline));
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function stop(directory: string): Promise<void> {
  const running = await status(directory);
  if (!running) return;
  const url = endpoint(running, "/shutdown");
  const capability = await token(directory);
  let response: Response | undefined;
  try {
    response = await direct(url, capability, 5000, "POST");
  } catch {
    // Cancellation closes accepted HTTP I/O as well as WebSockets. A lost
    // acknowledgement is not proof of shutdown: still await the readiness
    // removal barrier below, and never retry or signal a PID.
  }
  if (response && !response.ok) throw new Error(`Local server shutdown refused (${response.status})`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await lstat(resolve(directory, "server.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await wait();
  }
  throw new Error("Local server has not completed storage shutdown; inspect server.log");
}

async function createToken(directory: string) {
  const temporary = resolve(directory, `server.token.${process.pid}.tmp`);
  try {
    await writeFile(temporary, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    try {
      await link(temporary, resolve(directory, "server.token"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function startServer(
  binary: string,
  bundle: string,
  directory: string,
  mode: "bundle" | "plugins",
  deadline: number,
): Promise<Identity> {
  const log = await open(resolve(directory, "server.log"), "a", 0o600);
  const child = spawn(
    binary,
    ["--local-dir", directory, mode === "plugins" ? "--plugins" : "--bundle", bundle],
    {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      windowsHide: process.platform === "win32",
    },
  );
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
  });
  child.unref();
  await log.close();
  while (Date.now() < deadline) {
    const ready = await status(directory);
    if (ready) return ready;
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Local server exited before readiness; inspect server.log");
    }
    await wait();
  }
  throw new Error("Local server did not become ready; inspect server.log");
}
