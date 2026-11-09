import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentSources } from "../content-sources.mjs";
import { generatedDocs, syncContent } from "./sync-content.mjs";
import { remarkSourceLinks } from "../src/lib/remark-source-links";

test("sources update without drifting copies; optional pages appear and disappear", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokamak-wiki-content-"));
  const output = join(root, "output");
  const writeSource = async (source: string, text: string) => {
    const file = join(root, source);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  try {
    for (const source of contentSources.filter((entry) => !entry.optional)) {
      await writeSource(source.source, `Plain Markdown from ${source.source}\n`);
    }
    await syncContent(root, output);
    const overview = join(output, "how-it-works.md");
    assert.ok((await readFile(overview, "utf8")).includes('title: "How Tokamak works"'));
    const initial = await stat(overview);
    await syncContent(root, output);
    assert.equal((await stat(overview)).mtimeMs, initial.mtimeMs);
    assert.deepEqual(JSON.parse(await readFile(join(output, "meta.json"), "utf8")).pages.slice(0, 2),
      ["index", "how-it-works"]);
    assert.ok(!JSON.parse(await readFile(join(output, "meta.json"), "utf8")).pages.includes("engine"));
    for (const source of contentSources.filter((entry) => entry.optional)) {
      assert.ok(!existsSync(join(output, source.page)));
      await writeSource(source.source, "Optional documentation\n");
    }
    await writeSource("packages/server/README.md", "Fresh source content\n");
    await syncContent(root, output);
    assert.ok((await readFile(join(output, "server/index.md"), "utf8")).includes("Fresh source content"));
    assert.deepEqual(JSON.parse(await readFile(join(output, "runtime/meta.json"), "utf8")).pages,
      ["routing", "plugins"]);
    assert.ok(JSON.parse(await readFile(join(output, "meta.json"), "utf8")).pages.includes("engine"));
    for (const source of contentSources.filter((entry) => entry.optional)) {
      assert.ok((await readFile(join(output, source.page), "utf8")).includes("Optional documentation"));
      await rm(join(root, source.source));
    }
    await syncContent(root, output);
    for (const source of contentSources.filter((entry) => entry.optional)) {
      assert.ok(!existsSync(join(output, source.page)));
    }
    assert.deepEqual(JSON.parse(await readFile(join(output, "runtime/meta.json"), "utf8")).pages, ["routing"]);
    assert.ok(!JSON.parse(await readFile(join(output, "meta.json"), "utf8")).pages.includes("engine"));
    await rm(join(root, "packages/server/README.md"));
    await assert.rejects(syncContent(root, output), /Required wiki source is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("links resolve from the source path, preserve anchors, and leave code and external URLs intact", () => {
  const nodes = [
    { type: "link", url: "./PLUGINS.md#build-and-run" },
    { type: "definition", url: "../runtime/ROUTING.md?view=all#evidence" },
    { type: "link", url: "tests/README.md" },
    { type: "link", url: "#local" },
    { type: "link", url: "https://example.com/docs.md" },
    { type: "code", url: "./PLUGINS.md" },
  ];
  remarkSourceLinks()({ type: "root", children: nodes }, { path: join(generatedDocs, "server/index.md") });
  assert.deepEqual(nodes.map((node) => node.url), [
    "/docs/server/plugins#build-and-run",
    "/docs/runtime/routing?view=all#evidence",
    "https://github.com/pixelscortex/tokamak/blob/dev/packages/server/tests/README.md",
    "#local",
    "https://example.com/docs.md",
    "./PLUGINS.md",
  ]);
});
