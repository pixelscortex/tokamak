import { expect, test } from "bun:test";
import { join } from "node:path";
import { withPlugin, workspace } from "../../build/tests/outside-fixture.mjs";

test("a shared server receives no folder path and a superseded request reports replaced", async () => {
  await withPlugin(async (folder, root) => {
    const messages = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, listener) {
        if (listener.upgrade(request)) return;
        return new Response(null, { status: 404 });
      },
      websocket: {
        message(socket, payload) {
          const call = JSON.parse(String(payload));
          messages.push(call);
          const result = {
            "tokamak:whoami": { id: "owner", name: "Owner", role: "owner" },
            "chat/open:request": {
              threadId: "chat/threads:1",
              requestId: "chat/openRequests:1",
              created: true,
              agent: null,
              folderRecorded: false,
              local: false,
            },
            "chat/open:status": "replaced",
          }[call.name];
          if (call.type === "unsubscribe") return;
          socket.send(
            JSON.stringify({
              type: call.type === "subscribe" ? "subscription" : "response",
              id: call.id,
              result: result === undefined ? { Err: "Unexpected call" } : { Ok: result },
            }),
          );
        },
      },
    });
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          join(workspace, "packages/cli/src/main.ts"),
          "open",
          folder,
          "--server",
          `http://127.0.0.1:${server.port}`,
          "--json",
        ],
        {
          env: { ...process.env, TOKAMAK_SERVER_DIR: join(root, "data"), TOKAMAK_TOKEN: "fixture" },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ shown: "replaced", windowConnected: false, folder });
      expect(stderr).toContain("newer request replaced");
      expect(messages.find(({ name }) => name === "chat/open:request")?.args).toEqual({});
      expect(JSON.stringify(messages)).not.toContain(folder);
    } finally {
      server.stop(true);
    }
  });
});

test("window acknowledgement distinguishes pending, acknowledged and replaced with an injected deadline", async () => {
  const { waitForWindow } = await import("../src/commands/open");
  for (const expected of ["pending", "acknowledged", "replaced"]) {
    let stopped = false;
    const client = {
      subscribe(_status, args, notify) {
        expect(args).toEqual({ requestId: "request" });
        notify({ value: "pending" });
        if (expected !== "pending") notify({ value: expected });
        return () => {
          stopped = true;
        };
      },
    };
    expect(await waitForWindow(client, "request", 0)).toBe(expected);
    expect(stopped).toBe(true);
  }
});
