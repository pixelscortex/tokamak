import { prepareAgentEnvironment } from "../../../e2e/chat-sandbox.ts";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const workspace = resolve(import.meta.dir, "../../..");
const directory = await mkdtemp(resolve(tmpdir(), "tokamak-browser-assets-"));
const sandbox = await prepareAgentEnvironment(directory);
const fixture = resolve(directory, "browser");
const binary = resolve(workspace, "target/debug/tokamak");
for (const name of ["other", "browser"]) {
  const path = resolve(directory, name);
  await cp(resolve(workspace, "packages/build/tests/fixtures", name), path, {
    recursive: true,
    filter: (source) => !source.split("/").includes("dist"),
  });
  if (name === "browser")
    await writeFile(
      resolve(path, "tsconfig.json"),
      JSON.stringify({
        extends: resolve(workspace, "app/tsconfig.json"),
        include: ["src"],
      }),
    );
  const built = spawnSync("proto", ["run", "bun", "--", "packages/build/src/build.ts", path], {
    cwd: workspace,
    stdio: "inherit",
  });
  assert.equal(built.status, 0);
}
await mkdir(resolve(directory, "plugins/browser-fixture"), { recursive: true });
await cp(resolve(fixture, "dist"), resolve(directory, "plugins/browser-fixture/dist"), { recursive: true });

async function websocket(url, origin, expected) {
  const opened = await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: origin ? { Origin: origin } : {} });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket timeout"));
    }, 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
  assert.equal(opened, expected, `WebSocket ${origin ?? "without Origin"}`);
  console.log(`WebSocket ${origin ?? "without Origin"}: ${opened ? "opened" : "refused"}`);
}

try {
  for (const mode of ["loopback", "desktop", "configured"]) {
    const local = resolve(directory, mode, "local");
    const args = ["--plugins", resolve(directory, "plugins"), "--data", resolve(directory, mode, "store")];
    if (mode === "loopback") args.push("--listen", "127.0.0.1:43129");
    else {
      await mkdir(local, { recursive: true });
      await writeFile(resolve(local, "server.token"), randomBytes(32).toString("hex"), { mode: 0o600 });
      args.push("--local-dir", local);
    }
    const child = spawn(binary, args, {
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        ...sandbox.env,
        ...(mode === "configured" ? { TOKAMAK_ALLOWED_ORIGINS: "http://configured.example" } : {}),
      },
    });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    try {
      let base;
      let token = "";
      for (let attempt = 0; attempt < 200; attempt++) {
        if (child.exitCode !== null) throw new Error(`Server exited: ${child.exitCode}`);
        try {
          if (mode === "loopback") base = "http://127.0.0.1:43129";
          else {
            const identity = JSON.parse(await readFile(resolve(local, "server.json"), "utf8"));
            base = identity.url.replace("ws://", "http://").replace(/\/ws$/, "");
            token = await readFile(resolve(local, "server.token"), "utf8");
          }
          const ready = await fetch(`${base}/plugins${token ? `?token=${token}` : ""}`);
          if (ready.ok) break;
        } catch {}
        await delay(50);
      }
      assert(base, "Server startup");
      const origin = mode === "configured" ? "http://configured.example" : "http://127.0.0.1:1420";
      const query = token ? `?token=${token}` : "";
      const curl = async (path, origin, expected, suffix = query) => {
        const headers = resolve(directory, "headers");
        const body = resolve(directory, "body");
        const result = spawnSync(
          "curl",
          [
            "--silent",
            "--show-error",
            "--max-time",
            "5",
            "-D",
            headers,
            "-o",
            body,
            "-w",
            "%{http_code}",
            ...(origin ? ["-H", `Origin: ${origin}`] : []),
            `${base}${path}${suffix}`,
          ],
          { encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(Number(result.stdout), expected, path);
        const header = await readFile(headers, "utf8");
        console.log(`${mode} curl ${path} ${origin ?? "without Origin"}: ${result.stdout}`);
        return { header, body: await readFile(body, "utf8") };
      };
      const catalog = JSON.parse((await curl("/plugins", origin, 200)).body);
      const plugin = catalog.plugins[0];
      assert.equal(plugin.revision, catalog.revision);
      assert.equal(plugin.uiUrl, `/plugins/browser-fixture/${catalog.revision}/assets/ui.js`);
      const js = await curl(plugin.uiUrl, origin, 200);
      assert.match(js.header, /content-type: text\/javascript/i);
      assert(js.header.includes(`access-control-allow-origin: ${origin}`));
      assert.match(js.header, /cache-control: private, max-age=31536000, immutable/i);
      assert.match(js.body, /export \{/);
      await curl(plugin.stylesheetUrl, origin, 200);
      await curl(plugin.uiUrl, "http://untrusted.example", 403);
      await curl("/plugins/browser-fixture/stale/assets/ui.js", origin, 404);
      await curl(`/plugins/browser-fixture/${catalog.revision}/assets/bundle.js`, origin, 404);
      await curl(plugin.uiUrl, undefined, 200);
      if (mode === "configured") await curl(plugin.uiUrl, "http://127.0.0.1:1420", 403);
      if (token) {
        await curl(plugin.uiUrl, origin, 401, "");
        await curl(plugin.uiUrl, origin, 401, "?token=wrong");
      } else {
        await Bun.write("/tmp/tokamak-plugin-catalog-example.json", JSON.stringify(catalog, null, 2));
      }
      const ws = `${base.replace("http://", "ws://")}/ws`;
      await websocket(ws + query, origin, true);
      await websocket(ws + query, undefined, true);
      await websocket(ws + query, "http://untrusted.example", false);
      if (token) await websocket(ws, origin, false);
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
