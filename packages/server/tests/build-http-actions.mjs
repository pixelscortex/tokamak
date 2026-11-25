import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const root = process.argv[2];
for (const id of ["http-proxy", "http-peer"]) {
  const path = join(root, id);
  await mkdir(join(path, "src/server"), { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name: id, version: "1.0.0", type: "module" }));
  await symlink(join(workspace, "app/node_modules"), join(path, "node_modules"), "dir");
  await writeFile(
    join(path, "plugin.ts"),
    `
import { definePlugin } from "@tokamak/sdk";
export default definePlugin(${JSON.stringify({
      id,
      version: "1.0.0",
      permissions: id === "http-proxy" ? ["net:127.0.0.1"] : [],
    })});
`,
  );

  await writeFile(
    join(path, "vite.config.ts"),
    `import { tokamak } from ${JSON.stringify(join(workspace, "packages/build/src/vite.ts"))};
export default { plugins: [tokamak({ ui: false })] };`,
  );
  await writeFile(
    join(path, "src/server/ops.ts"),
    id === "http-proxy"
      ? `
import type {} from "@tokamak/sdk/web";
import { httpAction } from "@tokamak/sdk";

export const proxy = httpAction({
  path: "/:profile/*",
  handler: async (ctx, request) => {
    if (request.headers.get("x-key") !== "test-key") return new Response(null, { status: 401 });
    const target = new URL(request.url).searchParams.get("target");
    if (target) {
      const url = new URL(request.url);
      try {
        return await fetch(target, {
          headers: request.headers,
          signal: url.searchParams.has("ignore") ? undefined : request.signal,
        });
      } finally {
        const marker = url.searchParams.get("marker");
        if (marker && request.signal.aborted) await fetch(marker);
      }
    }
    if (ctx.params.profile === "size") return Response.json((await request.arrayBuffer()).byteLength);
    let serverUrl;
    try { serverUrl = ctx.serverUrl; } catch (error) { serverUrl = error instanceof Error ? error.message : String(error); }
    return Response.json({
      method: request.method,
      url: request.url,
      path: ctx.path, params: ctx.params, originalHost: ctx.originalHost, serverUrl,
      body: await request.text(),
    }, { status: 202, headers: { "x-fixture": "proxy" } });
  },
});
export const hang = httpAction({ path: "/hang", handler: () => new Promise(() => {}) });
export const broken = httpAction({
  path: "/broken",
  handler: async (_, request) => {
    const gate = new URL(request.url).searchParams.get("gate");
    if (!gate) throw new Error("missing gate");
    let first = true;
    return new Response(new ReadableStream({
      async pull(stream) {
        if (first) {
          first = false;
          stream.enqueue(new TextEncoder().encode("first"));
        } else {
          await fetch(gate);
          throw new Error("fixture crashed mid-body");
        }
      },
    }));
  },
});
export const informational = httpAction({
  path: "/informational",
  handler: () => Object.assign(new Response(), { status: 103 }),
});
export const fail = httpAction({
  path: "/fail/now",
  handler: () => { throw new Error("fixture failure"); },
});
`
      : `
import type {} from "@tokamak/sdk/web";
import { action, httpAction, query } from "@tokamak/sdk";

export const fast = httpAction({ path: "/ready", handler: () => new Response("ready") });
export const normal = action({ handler: () => "normal" });
export const overBudget = query({ handler: () => { for (;;) {} } });
`,
  );
  if (id === "http-peer")
    await writeFile(join(path, "src/server/api.ts"), 'export { normal, overBudget } from "./ops";\n');
  const child = Bun.spawn([process.execPath, join(workspace, "packages/build/src/build.ts"), path], {
    cwd: workspace,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`HTTP action fixture failed to build: ${id}`);
  const api = await Bun.file(join(path, "src/server/_generated/api.ts")).text();
  if (/ops:(proxy|fail|fast)\b/.test(api)) throw new Error("HTTP action leaked into callable references");
}
