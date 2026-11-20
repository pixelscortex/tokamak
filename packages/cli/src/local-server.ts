/** Local process ownership only; the server owns storage and shutdown. */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { link, lstat, mkdir, open, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { resolve, toNamespacedPath } from "node:path";
import { CommandError } from "./command";
import { acquireLock, codeOf } from "./lock";
import { inspectLocalServer, readToken, requestShutdown } from "./server";

type Identity = NonNullable<Awaited<ReturnType<typeof inspectLocalServer>>>["identity"];

const sharedServerEnv = new Set([
  "TOKAMAK_TOKEN",
  "TOKAMAK_ACCESS_TOKEN",
  "TOKAMAK_SERVER",
  "TOKAMAK_WEB_DIR",
]);

export function localServerEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !sharedServerEnv.has(name.toUpperCase())),
  );
}

async function lifecycleLock<T>(directory: string, action: () => Promise<T>) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = resolve(directory, "server-start.lock");
  // The desktop uses mkdir too. An empty lock may belong to the desktop.
  await acquireLock(
    () => mkdir(lock, { mode: 0o700 }),
    90_000,
    async (error) => {
      if (codeOf(error) !== "EEXIST") throw error;
    },
    `local server lifecycle lock: ${lock}`,
  );
  try {
    return await action();
  } finally {
    await rmdir(lock);
  }
}

async function hasFile(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(codeOf(error) ?? "")) return false;
    throw error;
  }
}

async function hasArtifact(folder: string) {
  return (
    (await hasFile(resolve(folder, "manifest.json"))) ||
    (await hasFile(resolve(folder, "dist/manifest.json")))
  );
}

async function checkPlugins(plugins: string) {
  if (await hasArtifact(plugins)) return;
  for (const name of await readdir(plugins)) {
    if (name.startsWith(".")) continue;
    const folder = resolve(plugins, name);
    if ((await hasFile(resolve(folder, "package.json"))) && !(await hasArtifact(folder))) {
      const arg = process.platform === "win32" ? `"${folder}"` : "'" + folder.replaceAll("'", "'\\''") + "'";
      throw new CommandError(
        "A plugin in the plugins folder has not been built",
        `proto run bun -- run tokamak plugin build ${arg}`,
      );
    }
  }
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
  return lifecycleLock(directory, async () => {
    const running = await inspectLocalServer(directory);
    if (running) {
      if (!running.responsive)
        throw new CommandError(
          "Local server is running but is not responding",
          `Inspect ${resolve(directory, "server.log")}`,
        );
      const { identity } = running;
      // Rust canonicalizes Windows paths to their extended-length form.
      if (
        !identity.pluginRoot ||
        toNamespacedPath(identity.pluginRoot) !== toNamespacedPath(plugins) ||
        identity.buildId !== buildId
      )
        throw new CommandError(
          "Local server is running with a different server build or plugins folder",
          "tokamak server stop",
        );
      return { identity, reused: true };
    }
    await checkPlugins(plugins);
    await createToken(directory);
    await readToken(directory);
    const identity = await startServer(binary, plugins, directory, Date.now() + 60_000);
    return { identity, reused: false };
  });
}

export async function stop(directory: string): Promise<boolean> {
  return lifecycleLock(directory, async () => {
    const running = await inspectLocalServer(directory);
    if (!running) return false;
    if (!running.responsive)
      throw new CommandError(
        "Local server is running but is not responding",
        `Inspect ${resolve(directory, "server.log")}`,
      );
    await requestShutdown(running.endpoint);
    return await waitForShutdown(directory);
  });
}

async function waitForShutdown(directory: string): Promise<boolean> {
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
    env: localServerEnv(),
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
    const ready = await inspectLocalServer(directory);
    if (ready?.responsive && ready.identity.pid === child.pid) return ready.identity;
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Local server exited before readiness; inspect server.log");
    }
    await wait();
  }
  throw new Error("Local server did not become ready; inspect server.log");
}
