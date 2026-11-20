import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkPluginImports, readPluginCompilerOptions } from "../../sdk/tools/plugin-boundary.mjs";
import ts from "typescript";
import { withPlugin } from "./outside-fixture.mjs";

async function put(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function section(id, side, body) {
  return `// Tokamak public ${side} declarations
declare module "plugin-types:${id}/${side}/public" { ${body} }
declare module "plugin:${id}/${side}" { export * from "plugin-types:${id}/${side}/public"; }
`;
}

async function artifact(root, folder, id, types) {
  const dist = join(root, folder, "dist");
  await put(join(dist, "public.d.ts"), types);
  await put(
    join(dist, "manifest.json"),
    JSON.stringify({
      plugin: { id },
      entries: { types: "public.d.ts" },
      hashes: { "public.d.ts": createHash("sha256").update(types).digest("hex") },
    }),
  );
}

test("a server-only consumer follows server types and ignores unrelated window dependencies", async () => {
  await withPlugin(async (consumer, root) => {
    await artifact(
      root,
      "one",
      "one",
      section("one", "server", 'export type T = import("plugin:two/server").U;') +
        section("one", "client", 'export type Unused = import("plugin:missing/client").Z;'),
    );
    await artifact(root, "two", "two", section("two", "server", "export type U = { n: number };"));
    const entry = join(consumer, "src/server/probe.ts");
    await put(entry, 'import type {T} from "plugin:one/server"; export const wrong: T = { n: "bad" };');
    await checkPluginImports(consumer);
    const options = readPluginCompilerOptions(consumer, dirname(entry));
    const diagnostics = ts
      .getPreEmitDiagnostics(ts.createProgram([entry], { ...options, skipLibCheck: true }))
      .filter((d) => d.file?.fileName === entry);
    expect(diagnostics.map((d) => d.code)).toEqual([2322]);
  });
});

test("rebuilding a dependency without a server API removes its old generated declarations", async () => {
  await withPlugin(async (consumer, root) => {
    const generated = join(consumer, ".tokamak/types/dep");
    await artifact(root, "provider", "dep", section("dep", "server", "export type Old = string;"));
    await checkPluginImports(consumer, undefined, ["dep"]);
    expect(await readFile(join(generated, "server.d.ts"), "utf8")).toContain("server");
    await artifact(root, "provider", "dep", section("dep", "client", "export type New = string;"));
    await checkPluginImports(consumer, undefined, ["dep"]);
    for (const name of ["server.d.ts", "server-types.d.ts"])
      expect(await Bun.file(join(generated, name)).exists()).toBe(false);
    expect(await readFile(join(generated, "public.d.ts"), "utf8")).toContain("New");
    await artifact(root, "provider", "dep", section("dep", "server", "export type Old = string;"));
    const entry = join(consumer, "src/server/old.ts");
    await put(entry, 'export type { Old } from "plugin:dep/server";');
    await checkPluginImports(consumer);
    await artifact(root, "provider", "dep", section("dep", "client", "export type New = string;"));
    await expect(checkPluginImports(consumer)).rejects.toThrow("has no public server API");
    expect(await Bun.file(join(generated, "server.d.ts")).exists()).toBe(false);
  });
});

test("lookup skips malformed manifests and reports duplicate providers", async () => {
  await withPlugin(async (consumer, root) => {
    await put(join(root, "a-malformed/dist/manifest.json"), "null");
    const types = section("dep", "server", "export type Value = string;");
    await artifact(root, "b-provider", "dep", types);
    await checkPluginImports(consumer, undefined, ["dep"]);
    expect(await readFile(join(consumer, ".tokamak/types/dep/public.d.ts"), "utf8")).toBe(types);
    await artifact(root, "c-provider", "dep", types);
    await expect(checkPluginImports(consumer, undefined, ["dep"])).rejects.toThrow(
      /dep.*b-provider.*c-provider/,
    );
  });
});

test("local discovery sends no token for a dead PID and bypasses proxy configuration", async () => {
  await withPlugin(async (consumer, root) => {
    const { fetchLocal } = await import("../../runtime/tools/local-server.ts");
    const data = join(root, "data");
    const token = "a".repeat(64);
    let requests = 0;
    let proxyRequests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests++;
        if (request.headers.get("authorization") !== `Bearer ${token}`)
          return new Response("", { status: 401 });
        return new URL(request.url).pathname === "/health"
          ? Response.json(identity(process.pid))
          : new Response("direct");
      },
    });
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        proxyRequests++;
        return new Response("unexpected proxy");
      },
    });
    const identity = (pid) => ({ pid, url: `ws://127.0.0.1:${server.port}/ws`, bundleHash: "b".repeat(64) });
    try {
      await mkdir(data);
      await writeFile(join(data, "server.token"), token, { mode: 0o600 });
      const exited = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
      await exited.exited;
      await put(join(data, "server.json"), JSON.stringify(identity(exited.pid)));
      const dead = await fetchLocal(data, "/probe").catch((error) => error);
      expect(requests).toBe(0);
      expect(dead).toBeUndefined();
      await put(join(data, "server.json"), JSON.stringify(identity(process.pid)));
      const proxyUrl = `http://127.0.0.1:${proxy.port}`;
      const runtime = new URL("../../runtime/tools/local-server.ts", import.meta.url).href;
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { fetchLocal } from ${JSON.stringify(runtime)}; console.log(await (await fetchLocal(process.argv[1], "/probe"))?.text());`,
          data,
        ],
        {
          cwd: consumer,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HTTP_PROXY: proxyUrl,
            http_proxy: proxyUrl,
            HTTPS_PROXY: proxyUrl,
            https_proxy: proxyUrl,
            ALL_PROXY: proxyUrl,
            NO_PROXY: "",
            no_proxy: "",
          },
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(stdout.trim()).toBe("direct");
      expect(requests).toBe(2);
      expect(proxyRequests).toBe(0);
    } finally {
      server.stop(true);
      proxy.stop(true);
    }
  });
}, 30_000);

test("a built neighbour wins over the server and the build reports its folder once", async () => {
  await withPlugin(async (consumer, root) => {
    const { build } = await import("./outside-fixture.mjs");
    const data = join(root, "data");
    await mkdir(data);
    const token = "a".repeat(64);
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response("");
      },
    });
    try {
      await writeFile(join(data, "server.token"), token, { mode: 0o600 });
      await put(
        join(data, "server.json"),
        JSON.stringify({
          pid: process.pid,
          url: `ws://127.0.0.1:${server.port}/ws`,
          bundleHash: "b".repeat(64),
        }),
      );
      await artifact(root, "old-provider", "dep", section("dep", "server", "export type Value = string;"));
      await put(
        join(consumer, "src/server/value.ts"),
        'import type { Value } from "plugin:dep/server"; export const value: Value = "sibling";',
      );
      const result = build(consumer, { TOKAMAK_SERVER_DIR: data });
      expect(result.code, result.output).toBe(0);
      expect(result.output.match(/Plugin types for dep: .*old-provider/g)).toHaveLength(1);
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
    }
  });
}, 30_000);
