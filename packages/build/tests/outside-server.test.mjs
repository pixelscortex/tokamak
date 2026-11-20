import { expect, test } from "bun:test";
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
