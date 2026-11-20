import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { build, withPlugin, workspace } from "./outside-fixture.mjs";

test("the server loads the external artifact and queries data written by its mutation", async () => {
  await withPlugin(async (plugin, root) => {
    const result = build(plugin);
    expect(result.code, result.output).toBe(0);
    const server = Bun.spawn(
      [
        join(workspace, "target/debug", process.platform === "win32" ? "tokamak.exe" : "tokamak"),
        "--plugins",
        root,
        "--data",
        join(root, "store"),
        "--listen",
        "127.0.0.1:0",
      ],
      { cwd: root, stdout: "pipe", stderr: "inherit" },
    );
    const logs = createInterface({ input: Readable.fromWeb(server.stdout) });
    const deadline = AbortSignal.timeout(10_000);
    let socket;
    try {
      const url = await new Promise((resolve, reject) => {
        deadline.addEventListener("abort", () => reject(new Error("Server startup timed out")));
        logs.on("line", (line) => {
          const url = /Tokamak listening on (ws:\/\/[^ ]+)/.exec(line)?.[1];
          if (url) resolve(url);
        });
        void server.exited.then((code) => reject(new Error(`Server exited with code ${code}`)));
      });
      socket = new WebSocket(url);
      const call = (type, id, operation, args) =>
        JSON.stringify({ type, id, name: `outside-fixture/notes:${operation}`, args });
      const notes = await new Promise((resolve, reject) => {
        deadline.addEventListener("abort", () => reject(new Error("Server call timed out")));
        socket.onerror = () => reject(new Error("WebSocket error"));
        socket.onopen = () => socket.send(call("mutation", 1, "add", { text: "outside checkout" }));
        socket.onmessage = ({ data }) => {
          const message = JSON.parse(data);
          if (message.type !== "response") return;
          if (!Object.hasOwn(message.result, "Ok")) {
            reject(new Error(data));
          } else if (message.id === 1) {
            socket.send(call("query", 2, "list", {}));
          } else if (message.id === 2) {
            resolve(message.result.Ok);
          }
        };
      });
      expect(notes).toEqual([expect.objectContaining({ text: "outside checkout" })]);
    } finally {
      socket?.close();
      logs.close();
      server.kill();
      await server.exited;
    }
  });
}, 30_000);

test("a plugin finds a dependency's public types on the running local server", async () => {
  await withPlugin(async (provider, root) => {
    await writeFile(join(provider, "src/server/api.ts"), 'export { list } from "./notes";');
    const published = build(provider);
    expect(published.code, published.output).toBe(0);
    const plugins = join(root, "installed");
    const local = join(root, "local");
    const consumer = join(root, "consumer");
    await mkdir(plugins);
    await mkdir(local);
    await mkdir(join(consumer, "src/server"), { recursive: true });
    await rename(join(provider, "dist"), join(plugins, "outside-fixture"));
    await writeFile(join(local, "server.token"), randomBytes(32).toString("hex"), { mode: 0o600 });
    await writeFile(
      join(consumer, "plugin.ts"),
      'import { definePlugin } from "@tokamak/sdk"; export default definePlugin({ id: "consumer", version: "1.0.0", depends: ["outside-fixture"] });',
    );
    await writeFile(
      join(consumer, "src/server/read.ts"),
      'import { action } from "@tokamak/sdk"; import { api } from "plugin:outside-fixture/server"; export const read = action({ handler: ctx => ctx.use(api).list({}) });',
    );
    const server = Bun.spawn(
      [
        join(workspace, "target/debug", process.platform === "win32" ? "tokamak.exe" : "tokamak"),
        "--plugins",
        plugins,
        "--local-dir",
        local,
      ],
      { cwd: root, stdout: "ignore", stderr: "inherit" },
    );
    try {
      const deadline = Date.now() + 15_000;
      while (!(await Bun.file(join(local, "server.json")).exists())) {
        if (server.exitCode !== null) throw new Error(`Server exited with code ${server.exitCode}`);
        if (Date.now() >= deadline) throw new Error("Server startup timed out");
        await Bun.sleep(25);
      }
      const result = build(consumer, { TOKAMAK_SERVER_DIR: local });
      expect(result.code, result.output).toBe(0);
      const declarations = await readFile(
        join(consumer, ".tokamak/types/outside-fixture/public.d.ts"),
        "utf8",
      );
      expect(declarations).toBe(await readFile(join(plugins, "outside-fixture/public.d.ts"), "utf8"));
    } finally {
      server.kill();
      await server.exited;
    }
  });
}, 90_000);
