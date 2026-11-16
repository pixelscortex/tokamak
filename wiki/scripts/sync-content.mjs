import { readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { contentSources } from "../content-sources.mjs";

export const wikiRoot = fileURLToPath(new URL("../", import.meta.url));
export const repoRoot = resolve(wikiRoot, "..");
export const generatedDocs = join(wikiRoot, ".generated/docs");

/** @param {string} file */
async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** @param {string} dir @returns {Promise<string[]>} */
async function filesIn(dir, prefix = "") {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesIn(join(dir, entry.name), name)));
    else files.push(name);
  }
  return files;
}

// Preserve the same directory depth as content/docs so SDK declaration paths
// keep working. Write only changed files, so a dev sync doesn't reload every page.
export async function syncContent(sourceRoot = repoRoot, output = generatedDocs) {
  /** @type {Map<string, string>} */
  const files = new Map();
  const authored = join(wikiRoot, "content/docs");
  for (const name of await filesIn(authored)) {
    files.set(name, await readFile(join(authored, name), "utf8"));
  }
  const included = [];
  for (const entry of contentSources) {
    const text = await readOptional(join(sourceRoot, entry.source));
    if (text === undefined) {
      if (entry.optional) continue;
      throw new Error(`Required wiki source is missing: ${entry.source}`);
    }
    included.push(entry);
    files.set(
      entry.page,
      `---\ntitle: ${JSON.stringify(entry.title)}\ndescription: ${JSON.stringify(entry.description)}\n---\n\n${text}`,
    );
  }
  // Optional sections appear only when their source exists, including after a
  // branch switch in dev. Never leave a stale page or dangling sidebar entry.
  for (const [folder, title] of Object.entries({ runtime: "Runtime", engine: "Engine" })) {
    const pages = included
      .filter((entry) => entry.page.startsWith(`${folder}/`))
      .map((entry) => entry.page.slice(folder.length + 1).replace(/\.md$/, ""));
    if (pages.length) files.set(`${folder}/meta.json`, JSON.stringify({ title, pages }, null, 2) + "\n");
  }
  if (included.some((entry) => entry.page.startsWith("engine/"))) {
    const meta = JSON.parse(files.get("meta.json") ?? "{}");
    meta.pages.splice(meta.pages.indexOf("api"), 0, "engine");
    files.set("meta.json", JSON.stringify(meta, null, 2) + "\n");
  }
  await mkdir(output, { recursive: true });
  for (const name of await filesIn(output)) {
    if (!files.has(name)) await rm(join(output, name));
  }
  for (const [name, text] of files) {
    const path = join(output, name);
    if ((await readOptional(path)) === text) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}

/** @returns {import('vite').Plugin} */
export function sourceContent() {
  return {
    name: "tokamak:source-content",
    // Also support invoking the Fumapress CLI directly.
    async config() {
      await syncContent();
    },
    configureServer(server) {
      const sources = new Set(contentSources.map((entry) => join(repoRoot, entry.source)));
      const authored = join(wikiRoot, "content/docs");
      // Watch parents as well, so optional files added later are detected.
      server.watcher.add([authored, ...[...sources].map(dirname)]);
      let pending = Promise.resolve();
      /** @param {string} event @param {string} file */
      const update = (event, file) => {
        if (
          !["add", "change", "unlink"].includes(event) ||
          (!sources.has(resolve(file)) && !resolve(file).startsWith(authored + sep))
        )
          return;
        pending = pending
          .then(() => syncContent())
          .catch((error) => {
            server.config.logger.error(`Wiki content sync failed: ${error.message}`);
          });
      };
      server.watcher.on("all", update);
      server.httpServer?.once("close", () => server.watcher.off("all", update));
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await syncContent();
}
