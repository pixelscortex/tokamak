import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withPlugin, workspace } from "../../build/tests/outside-fixture.mjs";

test("discovered and explicit loopback requests bypass environment proxies", async () => {
  await withPlugin(async (_, root) => {
    const received = [];
    let proxyRequests = 0;
    const token = "a".repeat(64);
    const catalog = { plugins: [] };
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${token}`) {
          return new Response(null, { status: 401 });
        }
        const path = new URL(request.url).pathname;
        received.push(path);
        return Response.json(path === "/health" ? identity : catalog);
      },
    });
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        proxyRequests++;
        return new Response(null, { status: 502 });
      },
    });
    const data = join(root, "data");
    const address = `http://127.0.0.1:${listener.port}`;
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const identity = {
      pid: process.pid,
      url: `ws://127.0.0.1:${listener.port}/ws`,
      bundleHash: "b".repeat(64),
    };
    try {
      await mkdir(data);
      await writeFile(join(data, "server.json"), JSON.stringify(identity));
      await writeFile(join(data, "server.token"), token, { mode: 0o600 });
      for (const explicit of [false, true]) {
        const child = Bun.spawn([process.execPath, "packages/cli/src/main.ts", "plugin", "list", "--json"], {
          cwd: workspace,
          env: {
            ...process.env,
            TOKAMAK_SERVER_DIR: data,
            TOKAMAK_SERVER: explicit ? address : undefined,
            TOKAMAK_TOKEN: explicit ? token : undefined,
            HTTP_PROXY: proxyUrl,
            HTTPS_PROXY: proxyUrl,
            ALL_PROXY: proxyUrl,
            http_proxy: proxyUrl,
            https_proxy: proxyUrl,
            all_proxy: proxyUrl,
            NO_PROXY: "",
            no_proxy: "",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, stderr).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ ok: true, ...catalog });
      }
      expect(received).toEqual(["/health", "/plugins", "/plugins"]);
      expect(proxyRequests).toBe(0);
    } finally {
      listener.stop(true);
      proxy.stop(true);
    }
  });
});
