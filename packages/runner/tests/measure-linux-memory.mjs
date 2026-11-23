import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

// See the Runner README for the release build and measurement procedure.
assert.equal(process.platform, "linux", "This benchmark uses Linux smaps_rollup");
const binary = resolve(process.argv[2] ?? "target/release/tokamak-runner");
const scratch = await mkdtemp("/tmp/tkm246-memory-");
const plugins = join(scratch, "plugins");
await mkdir(plugins);
const token = randomBytes(32).toString("hex");
const runner = spawn(binary, ["--desktop", "--plugins", plugins, "--data", join(scratch, "store")], {
  env: { ...process.env, TOKAMAK_PLUGIN_RUNTIME: "quickjs" },
  stdio: ["pipe", "pipe", "inherit"],
});
const exited = new Promise((resolve) => runner.on("exit", resolve));
const lines = createInterface({ input: runner.stdout });
const address = new Promise((resolve, reject) => {
  lines.on("line", (line) => {
    const ws = /^Tokamak listening on (\S+)/.exec(line);
    if (ws) resolve(ws[1]);
  });
  lines.once("close", () => reject(new Error("Runner exited")));
});
runner.stdin.write(token + "\n");
const sockets = [];
try {
  const url = new URL("/local-worker", await address);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const code = 'export const functions={warm:{kind:"local",args:{kind:"any"},invoke:()=>null}};';
  const entryHash = digest("");
  const codeHash = digest(code);
  async function warm(index) {
    const id = "bench-" + index;
    const folder = join(plugins, id);
    await mkdir(folder);
    await Promise.all([
      writeFile(join(folder, "local.js"), code),
      writeFile(join(folder, "local-entry.js"), ""),
      writeFile(
        join(folder, "manifest.json"),
        JSON.stringify({
          plugin: { id },
          entries: { local: { entry: "local-entry.js", code: "local.js" } },
          hashes: { "local-entry.js": entryHash, "local.js": codeHash },
        }),
      ),
    ]);
    const socket = new WebSocket(url, ["tokamak", "tokamak.bearer." + token]);
    sockets.push(socket);
    const send = (frame) => socket.send(JSON.stringify(frame));
    await new Promise((resolve, reject) => {
      socket.addEventListener("error", reject);
      socket.addEventListener("close", () => reject(new Error("Socket closed")));
      socket.addEventListener("open", () => send({ type: "start", artifact: { id, entryHash, codeHash } }));
      socket.addEventListener("message", ({ data }) => {
        const frame = JSON.parse(data);
        if (frame.type === "started")
          send({ type: "write", message: { type: "invoke", id: 1, fn: "warm", args: null } });
        else if (frame.message?.type === "op")
          send({ type: "write", message: { type: "opResult", id: frame.message.id, value: null } });
        else if (frame.message?.type === "result")
          frame.message.error ? reject(new Error(frame.message.error)) : resolve();
        else if (frame.type === "closed") reject(new Error(frame.reason));
      });
    });
  }
  async function memory() {
    const task = `/proc/${runner.pid}/task`;
    const children = new Set(
      (
        await Promise.all(
          (await readdir(task)).map(async (tid) =>
            readFile(join(task, tid, "children"), "utf8").catch(() => ""),
          ),
        )
      )
        .join(" ")
        .trim()
        .split(/\s+/),
    );
    const processes = (
      await Promise.all(
        [...children].map(async (pid) => {
          try {
            const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
            const isHost = args[1] === "--local-plugin";
            const isGuardian = args.includes("worker-guardian");
            if (!isHost && !isGuardian) return;
            const smaps = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
            const kib = (name) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(smaps)?.[1]);
            return {
              isHost,
              isGuardian,
              pss: kib("Pss"),
              anon: kib("Pss_Anon"),
              file: kib("Pss_File"),
              rss: kib("Rss"),
            };
          } catch {
            return;
          }
        }),
      )
    ).filter(Boolean);
    const summarize = (list) => ({
      count: list.length,
      pssKiB: list.reduce((total, p) => total + p.pss, 0),
      anonPssKiB: list.reduce((total, p) => total + p.anon, 0),
      filePssKiB: list.reduce((total, p) => total + p.file, 0),
      rssKiB: list.reduce((total, p) => total + p.rss, 0),
    });
    return {
      host: summarize(processes.filter((p) => p.isHost)),
      guardian: summarize(processes.filter((p) => p.isGuardian)),
    };
  }
  await warm(0);
  await Bun.sleep(200);
  const one = await memory();
  assert.equal(one.host.count, 1);
  console.log("One idle host: " + JSON.stringify(one));
  for (let i = 1; i < 100; i++) await warm(i);
  await Bun.sleep(400);
  const hundred = await memory();
  assert.equal(hundred.host.count, 100);
  console.log("100 idle hosts: " + JSON.stringify(hundred));
  console.log("Marginal host PSS KiB: " + ((hundred.host.pssKiB - one.host.pssKiB) / 99).toFixed(1));
} finally {
  for (const socket of sockets) socket.close();
  runner.stdin.end();
  assert.equal(await exited, 0);
}
