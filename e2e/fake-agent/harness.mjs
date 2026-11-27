// Shared fixture helpers for building plugins and connecting to the test server.
import assert from "node:assert/strict";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { TokamakClient, WebSocketTransport } from "../../packages/sdk/src/index.ts";
import { LocalFunctions } from "../../packages/runtime/js/local.ts";
import { bunPath, localLauncher, startRunner } from "./local.mjs";

export { bunPath, localLauncher, startRunner };

export const workspace = fileURLToPath(new URL("../../", import.meta.url));
const TIMEOUT_MS = 20_000;

/** Rejects with `label` when `promise` takes longer than `ms`. */
export async function within(promise, label, ms = TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Builds a plugin from source with the real build. */
export function build(folder) {
  const result = Bun.spawnSync([bunPath(), join(workspace, "packages/build/src/build.ts"), folder], {
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(result.exitCode, 0, `build ${folder}`);
}

/**
 * Copies a plugin's source to `into`, so a plugin that imports it
 * (`plugin:<id>/…`) can build beside it. The copy uses `modules` as its
 * node_modules and its server config points at the workspace directly.
 */
export async function copySource(from, into, modules) {
  await cp(from, into, {
    recursive: true,
    filter(path) {
      const name = basename(path);
      return (
        !["dist", "node_modules", ".tokamak", "target"].includes(name) &&
        !(basename(dirname(path)) === "_generated" && name.startsWith("build-"))
      );
    },
  });
  await symlink(modules, join(into, "node_modules"), "dir");
  await mkdir(join(into, "src/server"), { recursive: true });
  await writeFile(
    join(into, "src/server/tsconfig.json"),
    JSON.stringify({ extends: join(workspace, "tsconfig.json"), compilerOptions: { skipLibCheck: true } }),
  );
}

/** Starts the real server in `dir`; resolves its WebSocket address once it listens. */
export async function startServer({
  binary,
  dir,
  pluginsDir,
  shared,
  localDir,
  ownerToken,
  callMs,
  heapBytes,
  servers,
  cleanup,
  env = {},
  started = () => {},
  stdoutLine,
  stderr = "inherit",
}) {
  await mkdir(dir);
  const args = ["--plugins", pluginsDir, "--data", join(dir, "store"), "--listen", "127.0.0.1:0"];
  if (callMs !== undefined) args.push("--call-ms", String(callMs));
  if (heapBytes !== undefined) args.push("--heap-bytes", String(heapBytes));
  if (localDir) args.push("--local-dir", localDir);
  if (shared) {
    await writeFile(join(dir, "index.html"), "End-to-end server");
    args.push("--web", dir);
  }
  const child = Bun.spawn([binary, ...args], {
    env: { ...process.env, TOKAMAK_OWNER_NAME: "Sam", TOKAMAK_ACCESS_TOKEN: ownerToken, ...env },
    ...(localDir && { stdin: "pipe" }),
    stdout: "pipe",
    stderr,
  });
  servers.push(child);
  started(child);
  const lines = createInterface({ input: Readable.fromWeb(child.stdout) });
  cleanup.push(() => lines.close());
  return within(
    new Promise((resolve, reject) => {
      lines.on("line", (line) => {
        stdoutLine?.(line);
        const match = line.match(/ws:\/\/127\.0\.0\.1:\d+\/ws/);
        if (match) resolve(match[0]);
      });
      lines.on("close", () => reject(new Error("Server exited before readiness")));
    }),
    "server readiness",
  );
}

/** A window on `address` with device key `token`; with `launch`, also a local part. */
export async function connect(
  address,
  { token, launch, cleanup, onClose = /** @type {((event: CloseEvent) => void) | undefined} */ (undefined) },
) {
  const socket = new WebSocket(address, token ? ["tokamak", `tokamak.bearer.${token}`] : undefined);
  await within(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
    }),
    "WebSocket connection",
  );
  if (onClose) socket.addEventListener("close", onClose, { once: true });
  const transport = new WebSocketTransport(socket);
  cleanup.push(() => transport.close());
  if (!launch) return new TokamakClient(transport);
  const url = new URL(address);
  const part = new LocalFunctions(transport, launch, url.origin + url.pathname);
  cleanup.push(() => part.close());
  socket.addEventListener("close", ({ code }) => {
    if (code === 4001) void part.close();
  });
  return new TokamakClient(transport, part);
}

/** Subscribes to one query; `until(label, predicate, ms?)` waits for rows that match. */
export function watchQuery(client, reference, args, cleanup) {
  let latest;
  let failure;
  const waiters = new Set();
  const stop = client.subscribe(reference, args, (event) => {
    if ("error" in event) failure = event.error;
    else latest = event.value;
    for (const waiter of waiters) waiter();
  });
  cleanup.push(stop);
  return {
    current: () => latest,
    until(label, predicate, ms) {
      return within(
        new Promise((resolve, reject) => {
          const check = () => {
            if (failure) return reject(failure);
            if (latest !== undefined && predicate(latest)) {
              waiters.delete(check);
              resolve(latest);
            }
          };
          waiters.add(check);
          check();
        }),
        label,
        ms,
      );
    },
  };
}

/** Posts JSON to a server route with a bearer key; resolves the JSON answer. */
async function post(address, path, key, body, status = 200) {
  const response = await fetch(new URL(path, address.replace(/^ws:/, "http:")), {
    method: "POST",
    headers: { ...(key && { authorization: `Bearer ${key}` }), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

/** Adds a member and issues a device key only after their first password change. */
export async function signInMember(address, ownerKey, username, method) {
  const password = "temporary member password";
  const user = await post(address, "/members", ownerKey, {
    method,
    fields: { username, email: `${username.toLowerCase()}@example.com`, password },
  });
  const signIn = { method, deviceName: "Test device", fields: { usernameOrEmail: username, password } };
  const required = await post(address, "/auth/sign-in", undefined, signIn, 403);
  assert.equal(required.kind, "PasswordChangeRequired");
  const device = await post(address, "/auth/sign-in", undefined, {
    ...signIn,
    newPassword: "member's own password",
  });
  assert.ok(device.key, "password change issues a device key");
  return { ...device, user };
}
