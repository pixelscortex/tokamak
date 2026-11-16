/** Real local launcher/process checks, always using isolated ignored storage. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensure, status, stop } from "../../packages/runtime/tools/local-server";
import { WebSocketTransport } from "../../packages/sdk/src/transport";
import { TokamakClient } from "../../packages/sdk/src/client";
import { api } from "../dist/tests/todo/backend/_legacyApi";

const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(resolve(root, "app/dist/tests"), { recursive: true });
const directory = await mkdtemp(resolve(root, "app/dist/tests/local-"));
const binary = resolve(root, `target/debug/tokamak${process.platform === "win32" ? ".exe" : ""}`);
const bundle = resolve(root, "app/dist/tests/todo/dist/bundle.js");
const sockets: WebSocket[] = [];
const transports: WebSocketTransport[] = [];
async function client(url: string, capability: string) {
  // Bun's custom request headers are used only by this local process test.
  const NativeSocket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  const socket = new NativeSocket(url, { headers: { authorization: `Bearer ${capability}` } });
  sockets.push(socket);
  await new Promise<void>((done, reject) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
    setTimeout(() => reject(new Error("socket open deadline")), 5000).unref();
  });
  const transport = new WebSocketTransport(socket);
  transports.push(transport);
  return new TokamakClient(transport);
}
try {
  const [first, second] = await Promise.all([
    ensure(binary, bundle, directory),
    ensure(binary, bundle, directory),
  ]);
  assert.deepEqual(second, first, "concurrent launchers must reuse one ready server");
  const duplicate = spawnSync(binary, ["--local-dir", directory, "--bundle", bundle], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(duplicate.error);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Cannot acquire local server ownership/);
  assert.deepEqual(await status(directory), first, "another process cannot replace readiness");
  const capability = await readFile(resolve(directory, "server.token"), "utf8");
  if (process.platform !== "win32") {
    assert.equal((await stat(resolve(directory, "server.token"))).mode & 0o077, 0);
  }
  const base = first.url.replace("ws:", "http:").replace("/ws", "");
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/shutdown`, { method: "POST" })).status, 401);
  assert.equal(
    (
      await fetch(`${base}/health`, {
        headers: { authorization: `Bearer ${capability}`, origin: "https://example.com" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${base}/ws`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/ws`, {
        headers: { authorization: `Bearer ${capability}`, origin: "null" },
      })
    ).status,
    403,
  );
  assert.deepEqual(await status(directory), first);
  const one = await client(first.url, capability);
  const two = await client(first.url, capability);
  const id = await one.mutation(api.todo.add, { title: "standalone survives desktop close" });
  assert((await two.query(api.todo.list, {})).some((row) => row._id === id));
  transports.splice(0).forEach((transport) => transport.close());
  assert.deepEqual(await status(directory), first, "client close must not stop the service");
  const reopened = await client(first.url, capability);
  assert((await reopened.query(api.todo.list, {})).some((row) => row._id === id));
  const changed = resolve(directory, "changed.mjs");
  await writeFile(changed, `${await readFile(bundle, "utf8")}\n// changed bundle`);
  await assert.rejects(ensure(binary, changed, directory), /different backend bundle/);
  transports.splice(0).forEach((transport) => transport.close());
  await stop(directory);
  assert.equal(await status(directory), undefined);
  const restarted = await ensure(binary, bundle, directory);
  assert.notEqual(restarted.pid, first.pid);
  const persisted = await client(restarted.url, capability);
  assert((await persisted.query(api.todo.list, {})).some((row) => row._id === id));
  console.log(
    "PASS local service: concurrent reuse, capability/Origin gates, client close/reopen, revision guard, shutdown and persistence",
  );
} finally {
  transports.forEach((transport) => transport.close());
  sockets.forEach((socket) => socket.close());
  await stop(directory);
  await rm(directory, { recursive: true, force: true });
}
