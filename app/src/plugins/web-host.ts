import {
  createWindowState,
  offerWindowState,
  windowStateModule,
  windowStateStorage,
  type WindowStateTransport,
} from "@tokamak/sdk/window-state-host";
import { createSignal } from "solid-js";
import { parse } from "virtual:plugin-lexer";
import type { ModuleExports, PluginManifest, PluginModuleHost } from "../../../packages/runtime/js/plugins";
import { expandImporters } from "../../../packages/runtime/js/plugins";
import { bearerHeaders } from "../host/auth";
import { assetURL, type ServerEndpoint } from "./adapter";

type Generation = {
  urls: Set<string>;
  owners: Set<() => void>;
  stylesheet?: CSSStyleSheet;
  retired: boolean;
  modules: Map<string, Promise<string>>;
  exports?: ModuleExports;
  stateUrl?: string;
};
const moduleName = (id: string) => `@plugins/${id}/ui`;
const pluginIdOf = (name: string) => name.split("/")[1]!;

export class WebPluginHost implements PluginModuleHost {
  private generations = new Map<string, Generation>();
  // Module URLs rotate on reload; the window still owns the plugin's state.
  private stateScopes = createSignal<ReadonlyMap<string, ReturnType<typeof createWindowState>>>(new Map());
  private imports = new Map<string, Set<string>>();
  private moduleImports = new Map<string, Set<string>>();
  private listeners = new Map<string, Set<(cause: unknown) => void>>();
  private errors = new Map<string, unknown>();
  constructor(
    private endpoint: ServerEndpoint,
    private manifests: () => readonly PluginManifest[],
    private stateTransport?: WindowStateTransport,
    private workspaceKey = endpoint.http,
  ) {}
  hasUnsavedWindowState(): boolean {
    return [...this.stateScopes[0]().values()].some((scope) => scope.hasUnsavedChanges());
  }
  disposeWindowState() {
    const [scopes, setScopes] = this.stateScopes;
    for (const scope of scopes().values()) scope.dispose();
    setScopes(new Map());
  }
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
        const { stylesheet } = generation;
        if (stylesheet)
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== stylesheet);
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
      value = { urls: new Set(), owners: new Set(), retired: false, modules: new Map() };
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
    const response = await fetch(url, { headers: bearerHeaders(this.endpoint.token) });
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
      if (target === windowStateModule) {
        target = this.bindWindowState(name, generation);
      } else if (target.startsWith("@plugins/")) {
        const [, id, ...rest] = target.split("/");
        const manifest = this.manifests().find((p) => p.plugin.id === id);
        if (!manifest?.entries.ui) {
          // A dynamic import of an absent plugin is optional: leave it to reject
          // when called, so the importer's own fallback runs.
          if (entry.d >= 0) continue;
          throw new Error(`${name}: missing UI dependency ${target}`);
        }
        const dependency = moduleName(id!);
        this.attachStyles(manifest, this.generation(dependency));
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
  private bindWindowState(name: string, generation: Generation): string {
    if (generation.stateUrl) return generation.stateUrl;
    const plugin = pluginIdOf(name);
    const [scopes, setScopes] = this.stateScopes;
    let scope = scopes().get(plugin);
    if (!scope) {
      scope = createWindowState(windowStateStorage(plugin, this.workspaceKey, this.stateTransport));
      setScopes(new Map(scopes()).set(plugin, scope));
    }
    const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const source = `import { claimWindowState } from "@tokamak/sdk/window-state-host";
export default claimWindowState(${JSON.stringify(key)});`;
    generation.stateUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    generation.urls.add(generation.stateUrl);
    generation.owners.add(offerWindowState(key, scope));
    return generation.stateUrl;
  }
  private attachStyles(manifest: PluginManifest, generation: Generation) {
    const path = manifest.entries.ui?.css;
    if (!path || generation.stylesheet) return;
    const url = assetURL(this.endpoint, path);
    // A link cannot send Authorization, and the CSP blocks Blob stylesheet URLs.
    const sheet = new CSSStyleSheet();
    generation.stylesheet = sheet;
    void (async () => {
      const response = await fetch(url, { headers: bearerHeaders(this.endpoint.token) });
      if (!response.ok) throw new Error("Stylesheet failed to load");
      const css = await response.text();
      if (generation.retired) return;
      await sheet.replace(css);
      if (generation.retired) return;
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    })().catch((cause) => {
      if (!generation.retired) this.notifyError(moduleName(manifest.plugin.id), cause);
    });
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
