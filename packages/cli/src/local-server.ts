/** Local process ownership only; the server owns storage and shutdown. */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { link, lstat, mkdir, open, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";

// Bun fetch uses an empty proxy override to connect directly to loopback.
const direct = { proxy: "" };

type Identity = {
  pid: number;
  url: string;
  bundleHash: string;
  buildId?: string;
  pluginRoot?: string;
};

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
    !(url.hostname === "[::1]" || (isIP(url.hostname) === 4 && url.hostname.startsWith("127."))) ||
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

export async function status(directory: string): Promise<Identity | undefined> {
  let identity: Identity;
  try {
    identity = JSON.parse(await readFile(resolve(directory, "server.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    identity.pid > 0xffffffff ||
    !/^[a-f0-9]{64}$/i.test(identity.bundleHash)
  )
    throw new Error("Invalid local server discovery");
  const url = endpoint(identity, "/health");
  const capability = await token(directory);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${capability}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
      ...direct,
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
    if ([failure.code, failure.cause?.code].includes("ECONNREFUSED")) return;
    throw error;
  }
  if (!response.ok) throw new Error(`Local server health refused (${response.status})`);
  const actual = (await response.json()) as Identity;
  if (
    actual.pid !== identity.pid ||
    actual.url !== identity.url ||
    actual.bundleHash !== identity.bundleHash ||
    (actual.buildId ?? null) !== (identity.buildId ?? null) ||
    (actual.pluginRoot ?? null) !== (identity.pluginRoot ?? null)
  ) {
    throw new Error("Local server identity does not match discovery");
  }
  return identity;
}

async function wait(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

export async function ensure(
  binary: string,
  plugins: string,
  buildId: string,
  directory: string,
): Promise<{ identity: Identity; reused: boolean }> {
  function compatible(identity: Identity): Identity {
    // Keep this in step with the desktop's reuse_decision.
    if (identity.pluginRoot !== plugins || identity.buildId !== buildId) {
      throw new Error("Local server is running with a different build or plugins folder; stop it first");
    }
    return identity;
  }
  const running = await status(directory);
  if (running) return { identity: compatible(running), reused: true };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = resolve(directory, "server-start.lock");
  // Serialize launchers, not the actual server. A crashed launcher's stale lock
  // produces an explicit error; never kill a PID or silently steal ownership.
  let owner = false;
  const deadline = Date.now() + 60_000;
  while (!owner && Date.now() < deadline) {
    try {
      await mkdir(lock, { mode: 0o700 });
      owner = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const running = await status(directory);
      if (running) return { identity: compatible(running), reused: true };
      await wait();
    }
  }
  if (!owner) throw new Error("Local server startup lock is busy or stale; inspect server-start.lock");
  try {
    const running = await status(directory);
    if (running) return { identity: compatible(running), reused: true };
    await createToken(directory);
    await token(directory);
    const identity = await startServer(binary, plugins, directory, Date.now() + 60_000);
    return { identity: compatible(identity), reused: false };
  } finally {
    await rmdir(lock);
  }
}

export async function stop(directory: string): Promise<boolean> {
  const running = await status(directory);
  if (!running) return false;
  const url = endpoint(running, "/shutdown");
  const capability = await token(directory);
  let response: Response | undefined;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${capability}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
      ...direct,
    });
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
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
  plugins: string,
  directory: string,
  deadline: number,
): Promise<Identity> {
  const log = await open(resolve(directory, "server.log"), "a", 0o600);
  const child = spawn(binary, ["--local-dir", directory, "--plugins", plugins], {
    detached: true,
    env: { ...process.env, TOKAMAK_WEB_DIR: undefined },
    stdio: ["ignore", log.fd, log.fd],
    windowsHide: process.platform === "win32",
  });
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
  });
  child.unref();
  await log.close();
  while (Date.now() < deadline) {
    const ready = await status(directory);
    if (ready && ready.pid === child.pid) return ready;
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Local server exited before readiness; inspect server.log");
    }
    await wait();
  }
  throw new Error("Local server did not become ready; inspect server.log");
}
