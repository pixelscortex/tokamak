import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspace } from "./outside-fixture.mjs";

test("the desktop production import map serves identical shared functions", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "tokamak-window-"));
  try {
    const result = Bun.spawnSync([process.execPath, "run", "build", "--outDir", outDir], {
      cwd: join(workspace, "app"),
      env: { ...process.env, NODE_ENV: "production", TOKAMAK_PLUGIN_FIXTURES: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
    await writeFile(join(outDir, "package.json"), '{"type":"module"}');
    const html = await Bun.file(join(outDir, "index.html")).text();
    const { imports } = JSON.parse(html.match(/<script type="importmap">\s*(.*?)\s*<\/script>/s)[1]);
    const modules = new Map();
    const different = [];
    for (const [id, url] of Object.entries(imports)) {
      const root = id
        .split("/")
        .slice(0, id.startsWith("@") ? 2 : 1)
        .join("/");
      if (!modules.has(root)) modules.set(root, new Map());
      const names = modules.get(root);
      for (const [name, value] of Object.entries(await import(join(outDir, url)))) {
        if (typeof value !== "function") continue;
        if (!names.has(name)) names.set(name, { id, value });
        else if (value !== names.get(name).value)
          different.push(`${id}: ${name} differs from ${names.get(name).id}`);
      }
    }
    expect(different).toEqual([]);
    expect(imports).toHaveProperty("solid-js");
    expect(imports).toHaveProperty("@solidjs/web/jsx-runtime");
    expect(Object.keys(imports)).not.toContain("@solidjs/web/jsx-dev-runtime");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}, 30_000);
