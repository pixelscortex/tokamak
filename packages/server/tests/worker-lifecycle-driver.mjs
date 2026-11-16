import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const [url, server, scenario] = process.argv.slice(2);
async function deadline(promise, ms = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${scenario} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error(`${scenario}: condition timed out`);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
let socket;
let pids;
try {
  socket = new WebSocket(url);
  await deadline(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
  );
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.type !== "response") return;
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message);
  });
  async function call(name, args = {}) {
    const id = ++next;
    const result = new Promise((resolve) => pending.set(id, resolve));
    socket.send(JSON.stringify({ type: "action", id, name: `worker-test/actions:${name}`, args }));
    const message = await deadline(result);
    assert.equal(message.result.Err, undefined, JSON.stringify(message));
    return message.result.Ok;
  }
  pids = await call("child");
  assert.ok(alive(pids.child));
  const state = await call("state");
  const marker = join(state.cwd, "cpu-started");
  rmSync(marker, { force: true });
  if (scenario === "logs") {
    for (const stderr of [false, true]) assert.equal(await call("flood", { stderr }), "flooded");
    assert.equal(await call("echo", { value: "alive", delay: 0 }), "alive");
  }
  // The marker proves the worker entered the synchronous loop before killing its parent.
  socket.send(JSON.stringify({ type: "action", id: ++next, name: "worker-test/actions:cpu", args: {} }));
  await until(() => existsSync(marker));
  process.kill(Number(server), scenario === "logs" ? "SIGTERM" : "SIGKILL");
  await until(() => !alive(pids.worker) && !alive(pids.child));
  console.log(`${scenario}: invocation and shutdown completed; worker and child gone`);
} finally {
  socket?.close();
  if (pids) {
    try {
      process.kill(-pids.worker, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
