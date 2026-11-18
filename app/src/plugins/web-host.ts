import { parse } from "virtual:plugin-lexer";
import type { ModuleExports, PluginManifest, PluginModuleHost } from "../../../packages/runtime/js/plugins";
import { expandImporters } from "../../../packages/runtime/js/plugins";
import { assetURL, type ServerEndpoint } from "./adapter";

type Generation = {
  urls: Set<string>;
  owners: Set<() => void>;
  styles: HTMLLinkElement[];
  retired: boolean;
  modules: Map<string, Promise<string>>;
  exports?: ModuleExports;
};
const moduleName = (id: string) => `@plugins/${id}/ui`;
export class WebPluginHost implements PluginModuleHost {
  private generations = new Map<string, Generation>();
  private imports = new Map<string, Set<string>>();
  private moduleImports = new Map<string, Set<string>>();
  private listeners = new Map<string, Set<(cause: unknown) => void>>();
  private errors = new Map<string, unknown>();
  constructor(
    private endpoint: ServerEndpoint,
    private manifests: () => readonly PluginManifest[],
  ) {}
  affected(names: readonly string[]) {
    const affected = new Set(names);
    const importers = new Map<string, Set<string>>();
    for (const [name, dependencies] of this.imports)
      for (const dependency of dependencies) {
        const values = importers.get(dependency) ?? new Set();
        values.add(name);
        importers.set(dependency, values);
      }
    expandImporters(affected, importers);
    return affected;
  }
  remove(names: Iterable<string>) {
    for (const name of names) {
      const generation = this.generations.get(name);
      if (generation) {
        generation.retired = true;
        for (const dispose of generation.owners) dispose();
        for (const style of generation.styles) style.remove();
        for (const url of generation.urls) URL.revokeObjectURL(url);
        for (const url of generation.modules.keys()) this.moduleImports.delete(url);
      }
      this.generations.delete(name);
      this.imports.delete(name);
      this.errors.delete(name);
    }
  }
  own(id: string, dispose: () => void): () => void {
    const generation = this.generations.get(moduleName(id));
    if (!generation || generation.retired) {
      dispose();
      return () => {};
    }
    generation.owners.add(dispose);
    return () => generation.owners.delete(dispose);
  }
  private generation(name: string): Generation {
    let value = this.generations.get(name);
    if (!value) {
      value = { urls: new Set(), owners: new Set(), styles: [], retired: false, modules: new Map() };
      this.generations.set(name, value);
    }
    return value;
  }
  private live(generation: Generation) {
    if (generation.retired) throw new Error("Retired plugin generation");
  }
  private async prepare(name: string, path: string, stack: readonly string[]): Promise<string> {
    const generation = this.generation(name);
    const url = assetURL(this.endpoint, path);
    if (stack.includes(url)) throw new Error(`${name}: UI module dependency cycle`);
    const parent = stack.at(-1);
    if (parent) {
      const reachable = new Set([url]);
      for (const current of reachable)
        for (const next of this.moduleImports.get(current) ?? []) reachable.add(next);
      if (reachable.has(parent)) throw new Error(`${name}: UI module dependency cycle`);
      const edges = this.moduleImports.get(parent) ?? new Set();
      edges.add(url);
      this.moduleImports.set(parent, edges);
    }
    const cached = generation.modules.get(url);
    if (cached) return cached;
    const task = this.rewrite(name, url, generation, [...stack, url]);
    generation.modules.set(url, task);
    // A failure is not cached: the next load of an importer fetches again.
    task.catch(() => {
      if (generation.modules.get(url) === task) generation.modules.delete(url);
    });
    return task;
  }
  private async rewrite(name: string, url: string, generation: Generation, stack: readonly string[]) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    let code = await response.text();
    this.live(generation);
    const [imports] = parse(code);
    const edits: { start: number; end: number; text: string }[] = [];
    for (const entry of imports) {
      this.live(generation);
      if (entry.d === -2) {
        // Blob import.meta.url would break asset URLs relative to the server entry.
        if (code.slice(entry.e, entry.e + 4) === ".url")
          edits.push({ start: entry.s, end: entry.e + 4, text: JSON.stringify(url) });
        continue;
      }
      if (!entry.n) throw new Error(`${name}: nonliteral dynamic imports are unsupported`);
      let target = entry.n;
      if (target.startsWith("@plugins/")) {
        const [, id, ...rest] = target.split("/");
        const manifest = this.manifests().find((p) => p.plugin.id === id);
        if (!manifest?.entries.ui) {
          // A dynamic import of an absent plugin is optional: leave it to reject
          // when called, so the importer's own fallback runs.
          if (entry.d >= 0) continue;
          throw new Error(`${name}: missing UI dependency ${target}`);
        }
        this.attachStyles(manifest, this.generation(moduleName(id!)));
        const dependency = moduleName(id!);
        const dependencies = this.imports.get(name) ?? new Set();
        dependencies.add(dependency);
        this.imports.set(name, dependencies);
        const suffix = rest.join("/");
        const path = ["", "ui", "client", "src/client/api", "src/client/api.ts"].includes(suffix)
          ? manifest.entries.ui.code
          : new URL(suffix, new URL(manifest.entries.ui.code, this.endpoint.http)).href;
        target = await this.prepare(dependency, path, stack);
      } else if (/^(\.|\/|https?:)/.test(target)) {
        target = await this.prepare(name, new URL(target, url).href, stack);
      } else continue;
      edits.push({ start: entry.s, end: entry.e, text: entry.d >= 0 ? JSON.stringify(target) : target });
    }
    this.live(generation);
    for (const edit of edits.sort((a, b) => b.start - a.start))
      code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
    const blob = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    generation.urls.add(blob);
    return blob;
  }
  private attachStyles(manifest: PluginManifest, generation: Generation) {
    if (!manifest.entries.ui?.css || generation.styles.length) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = assetURL(this.endpoint, manifest.entries.ui.css);
    link.dataset.plugin = manifest.plugin.id;
    link.onerror = () => {
      if (!generation.retired)
        this.notifyError(moduleName(manifest.plugin.id), new Error("Stylesheet failed to load"));
    };
    generation.styles.push(link);
    document.head.append(link);
  }
  async importModule(name: string, manifest: PluginManifest): Promise<ModuleExports> {
    const generation = this.generation(name);
    try {
      const url = await this.prepare(name, manifest.entries.ui!.code, []);
      this.live(generation);
      this.attachStyles(manifest, generation);
      const exports: ModuleExports = await import(/* @vite-ignore */ url);
      this.live(generation);
      generation.exports = exports;
      return exports;
    } catch (cause) {
      if (!generation.retired) this.notifyError(name, cause);
      throw cause;
    }
  }
  notifyError(name: string, cause: unknown) {
    const error = new Error(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    for (const affected of this.affected([name])) {
      this.errors.set(affected, error);
      for (const listener of this.listeners.get(affected) ?? []) listener(error);
    }
  }
  onError(name: string, listener: (cause: unknown) => void) {
    const values = this.listeners.get(name) ?? new Set();
    values.add(listener);
    this.listeners.set(name, values);
    if (this.errors.has(name)) listener(this.errors.get(name));
    return () => {
      values.delete(listener);
      if (!values.size) this.listeners.delete(name);
    };
  }
  dependencies(name: string) {
    return [...(this.imports.get(name) ?? [])];
  }
  has(name: string) {
    return this.generations.has(name);
  }
  require(name: string) {
    const value = this.generations.get(name)?.exports;
    if (!value) throw new Error(`Not loaded: ${name}`);
    return value;
  }
  evaluate(): never {
    throw new Error("Web plugins require an ES module URL");
  }
  setLoader() {}
}
