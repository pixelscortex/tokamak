/** Manifest-first loading and generation retirement. No UI asset is requested
 * until load() is called by a contribution or a cross-plugin import. */
import { batch, createSignal } from "solid-js";
import type { ContributionKind, JsonValue } from "@tokamak/sdk";
import { ModuleRegistry, type ModuleExports } from "./modules";

export interface PluginManifest {
  plugin: {
    id: string;
    version: string;
    depends?: Readonly<Record<string, string>>;
    contributes?: Partial<Record<ContributionKind, readonly { id: string; [key: string]: string }[]>>;
  };
  entries: { ui?: { code: string; css: string } };
  hashes: Readonly<Record<string, string>>;
}
export interface PluginCatalog { revision: string; plugins: readonly PluginManifest[] }
export interface PluginAssets {
  plugins(): Promise<JsonValue>;
  pluginAsset(plugin: string, name: string, revision: string): Promise<string>;
  onPluginsChanged(listener: (event: { plugins: string[]; catalog: JsonValue }) => void): () => void;
}
export interface SlotContribution { plugin: string; id: string; kind: ContributionKind; options: Readonly<Record<string, string>> }
const moduleName = (id: string) => `@plugins/${id}/ui`;
function catalog(value: JsonValue): PluginCatalog {
  const candidate = value as unknown as PluginCatalog;
  if (!candidate || typeof candidate.revision !== "string" || !Array.isArray(candidate.plugins)
    || candidate.plugins.some(p => !p?.plugin || typeof p.plugin.id !== "string" || !p.entries)) throw new Error("Invalid plugin catalog");
  return candidate;
}

export function createPluginLoader(registry: ModuleRegistry, assets: PluginAssets) {
  const [metadata, setMetadata] = createSignal<PluginCatalog>({ revision: "", plugins: [] });
  const [versions, setVersions] = createSignal<Readonly<Record<string, number>>>({});
  const [styles, setStyles] = createSignal<Readonly<Record<string, string>>>({});
  const loaded = new Map<string, ModuleExports>();
  const pending = new Map<string, Promise<ModuleExports>>();
  let disposed = false;
  let changes = 0;
  const invalidations = new Set<string>();
  const version = (id: string) => versions()[id] ?? 0;
  const manifest = (id: string) => metadata().plugins.find(p => p.plugin.id === id);

  function invalidate(ids: readonly string[], next = metadata()) {
    const affected = registry.affected(ids.map(moduleName));
    // Include not-yet-evaluated importers using the static dependency graph.
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of [...metadata().plugins, ...next.plugins]) {
        if (!affected.has(moduleName(p.plugin.id)) && Object.keys(p.plugin.depends ?? {}).some(id => affected.has(moduleName(id)))) {
          affected.add(moduleName(p.plugin.id)); grew = true;
        }
      }
    }
    for (const id of pending.keys()) affected.add(moduleName(id));
    batch(() => {
      const updated = { ...versions() };
      const css = { ...styles() };
      for (const name of affected) {
        const id = name.slice("@plugins/".length, -"/ui".length);
        updated[id] = (updated[id] ?? 0) + 1;
        delete css[id]; pending.delete(id); loaded.delete(id);
      }
      setVersions(updated);
      setStyles(css);
      registry.remove(affected);
      setMetadata(next);
    });
  }

  async function load(id: string, stack: readonly string[] = []): Promise<ModuleExports> {
    if (disposed) throw new Error("Plugin loader disposed");
    if (stack.includes(id)) throw new Error(`UI dependency cycle: ${[...stack, id].join(" -> ")}`);
    if (loaded.has(id)) return loaded.get(id)!;
    if (pending.has(id)) return pending.get(id)!;
    const p = manifest(id);
    if (!p?.entries.ui) throw new Error(`Plugin has no UI module: ${id}`);
    const revision = metadata().revision;
    const generation = version(id);
    const live = () => {
      if (disposed || generation !== version(id) || revision !== metadata().revision) throw new Error(`Retired plugin generation: ${id}`);
    };
    const task = (async () => {
      const entry = p.entries.ui!;
      // Manifest depends also includes backend requirements. Register this
      // inert factory first, then resolve only its actual UI imports; otherwise
      // a backend dependency would prematurely fetch an unrelated UI module.
      const code = await assets.pluginAsset(id, entry.code, revision);
      live();
      registry.evaluate(moduleName(id), code);
      for (const dependency of registry.dependencies(moduleName(id))) {
        if (dependency.startsWith("@plugins/")) await load(dependency.slice(9, -3), [...stack, id]);
        else if (!registry.has(dependency)) throw new Error(`Unsupported host module: ${dependency}`);
      }
      const css = await assets.pluginAsset(id, entry.css, revision);
      live();
      const exports = registry.require(moduleName(id));
      setStyles(previous => ({ ...previous, [id]: css }));
      return exports;
    })();
    pending.set(id, task);
    try {
      const exports = await task;
      live();
      loaded.set(id, exports);
      pending.delete(id);
      return exports;
    }
    catch (error) {
      if (generation === version(id)) {
        registry.remove([moduleName(id)]);
        pending.delete(id);
      }
      throw error;
    }
  }

  registry.setLoader(name => load(name.slice(9, -3)));
  const stop = assets.onPluginsChanged(event => {
    changes++;
    for (const id of event.plugins) invalidations.add(id);
    const publish = (next: JsonValue) => {
      invalidate([...invalidations], catalog(next));
      invalidations.clear();
    };
    const value = event.catalog as unknown as { paged?: boolean };
    if (value.paged) {
      const change = changes;
      // Multiple reloads can race a paged fetch. Accumulate every changed id
      // until the latest complete catalog arrives, so none escapes retirement.
      void assets.plugins().then(next => {
        if (!disposed && change === changes) publish(next);
      }).catch(error => {
        if (!disposed && change === changes) for (const id of invalidations) registry.notifyError(moduleName(id), error);
      });
    } else publish(event.catalog);
  });
  return {
    metadata, version, styles, load,
    onError(id: string, listener: (cause: unknown) => void) { return registry.onError(moduleName(id), listener); },
    async connect() {
      const before = changes;
      try {
        const value = await assets.plugins();
        if (!disposed && changes === before) setMetadata(catalog(value));
      } catch (error) {
        // A newer catalog fetch owns the outcome after a reload. An older
        // transfer's stale-page failure must not become a permanent shell alert.
        if (!disposed && changes === before) throw error;
      }
    },
    contributions(kind: ContributionKind): SlotContribution[] {
      return metadata().plugins.flatMap(p => (p.plugin.contributes?.[kind] ?? []).map(options => ({
        plugin: p.plugin.id, id: options.id, kind, options,
      })));
    },
    reload(id: string) { invalidate([id]); },
    dispose() { disposed = true; stop(); invalidate(metadata().plugins.map(p => p.plugin.id)); },
  };
}
export type PluginLoader = ReturnType<typeof createPluginLoader>;
