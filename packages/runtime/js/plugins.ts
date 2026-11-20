/** Manifest-first loading and generation retirement. No UI asset is requested
 * until load() is called by a contribution or a cross-plugin import. */
import { createMemo, createSignal } from "solid-js";
import type { ContributionKind, JsonValue } from "@tokamak/sdk";
export type ModuleExports = Readonly<Record<string, unknown>>;
export interface PluginModuleHost {
  importModule?(name: string, manifest: PluginManifest, revision: string): Promise<ModuleExports>;
  affected(names: readonly string[]): Set<string>;
  remove(names: Iterable<string>, options?: { keepImports?: boolean }): void;
  evaluate(name: string, code: string): void;
  dependencies(name: string): readonly string[];
  has(name: string): boolean;
  require(name: string): ModuleExports;
  setLoader(load: (name: string) => Promise<ModuleExports>): void;
  notifyError(name: string, cause: unknown): void;
  onError(name: string, listener: (cause: unknown) => void): () => void;
}

export interface PluginManifest {
  revision?: string;
  plugin: {
    id: string;
    version: string;
    depends?: Readonly<Record<string, string>>;
    contributes?: Partial<
      Record<ContributionKind, readonly { id: string; [key: string]: string | number }[]>
    >;
  };
  entries: { ui?: { code: string; css: string } };
  hashes: Readonly<Record<string, string>>;
}
export interface PluginCatalog {
  revision: string;
  plugins: readonly PluginManifest[];
}
export interface PluginAssets {
  plugins(): Promise<JsonValue>;
  pluginAsset(plugin: string, name: string, revision: string): Promise<string>;
  onPluginsChanged(listener: (event: { plugins: string[]; catalog: JsonValue }) => void): () => void;
}
export interface SlotContribution {
  plugin: string;
  id: string;
  kind: ContributionKind;
  options: Readonly<Record<string, string | number>>;
}
const moduleName = (id: string) => `@plugins/${id}/ui`;
function catalog(value: JsonValue): PluginCatalog {
  const candidate = value as unknown as PluginCatalog;
  if (
    !candidate ||
    typeof candidate.revision !== "string" ||
    !Array.isArray(candidate.plugins) ||
    candidate.plugins.some((p) => !p?.plugin || typeof p.plugin.id !== "string" || !p.entries)
  )
    throw new Error("Invalid plugin catalog");
  return candidate;
}

export function createPluginLoader(registry: PluginModuleHost, assets: PluginAssets) {
  const [metadata, setMetadata] = createSignal<PluginCatalog>({ revision: "", plugins: [] });
  const [versions, setVersions] = createSignal<Readonly<Record<string, number>>>({});
  const [styles, setStyles] = createSignal<Readonly<Record<string, string>>>({});
  const loaded = new Map<string, ModuleExports>();
  const pending = new Map<string, Promise<ModuleExports>>();
  let disposed = false;
  let changes = 0;
  const invalidations = new Set<string>();
  const version = (id: string) => versions()[id] ?? 0;
  const manifests = createMemo(() => new Map(metadata().plugins.map((p) => [p.plugin.id, p])));
  const manifest = (id: string) => manifests().get(id);

  function invalidate(ids: readonly string[], next = metadata()) {
    const affected = registry.affected(ids.map(moduleName));
    const updated = { ...versions() };
    const css = { ...styles() };
    for (const name of affected) {
      const id = name.slice("@plugins/".length, -"/ui".length);
      updated[id] = (updated[id] ?? 0) + 1;
      delete css[id];
      pending.delete(id);
      loaded.delete(id);
    }
    registry.remove(affected);
    setMetadata(next);
    setVersions(updated);
    setStyles(css);
  }

  async function load(id: string, stack: readonly string[] = []): Promise<ModuleExports> {
    if (disposed) throw new Error("Plugin loader disposed");
    if (stack.includes(id)) throw new Error(`UI dependency cycle: ${[...stack, id].join(" -> ")}`);
    if (loaded.has(id)) return loaded.get(id)!;
    if (pending.has(id)) return pending.get(id)!;
    const p = manifest(id);
    if (!p?.entries.ui) throw new Error(`Plugin has no UI module: ${id}`);
    const revision = p.revision ?? metadata().revision;
    const generation = version(id);
    const live = () => {
      if (disposed || generation !== version(id)) throw new Error(`Retired plugin generation: ${id}`);
    };
    const task = (async () => {
      if (registry.importModule) return registry.importModule(moduleName(id), p, revision);
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
      setStyles((previous) => ({ ...previous, [id]: css }));
      return exports;
    })();
    pending.set(id, task);
    try {
      const exports = await task;
      live();
      loaded.set(id, exports);
      pending.delete(id);
      return exports;
    } catch (error) {
      if (generation === version(id)) {
        registry.remove([moduleName(id)], { keepImports: true });
        pending.delete(id);
      }
      throw error;
    }
  }

  registry.setLoader((name) => load(name.slice(9, -3)));
  const stop = assets.onPluginsChanged((event) => {
    changes++;
    for (const id of event.plugins) invalidations.add(id);
    const publish = (next: JsonValue) => {
      const parsed = catalog(next);
      const nextManifests = new Map(parsed.plugins.map((p) => [p.plugin.id, p]));
      // Very large change-id lists are omitted from the bounded notification.
      // Diff the complete paged catalog too, so no installed-count ceiling can
      // silently prevent a module from retiring (including added/removed ids).
      for (const [id, previous] of manifests()) {
        if (JSON.stringify(previous) !== JSON.stringify(nextManifests.get(id))) invalidations.add(id);
      }
      for (const id of nextManifests.keys()) if (!manifests().has(id)) invalidations.add(id);
      invalidate([...invalidations], parsed);
      invalidations.clear();
    };
    const value = event.catalog as unknown as { paged?: boolean };
    if (value.paged) {
      const change = changes;
      // Multiple reloads can race a paged fetch. Accumulate every changed id
      // until the latest complete catalog arrives, so none escapes retirement.
      void assets
        .plugins()
        .then((next) => {
          if (!disposed && change === changes) publish(next);
        })
        .catch((error) => {
          if (!disposed && change === changes)
            for (const id of invalidations) registry.notifyError(moduleName(id), error);
        });
    } else publish(event.catalog);
  });
  return {
    metadata,
    version,
    styles,
    load,
    onError(id: string, listener: (cause: unknown) => void) {
      return registry.onError(moduleName(id), listener);
    },
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
      return metadata().plugins.flatMap((p) =>
        (p.plugin.contributes?.[kind] ?? []).map((options) => ({
          plugin: p.plugin.id,
          id: options.id,
          kind,
          options,
        })),
      );
    },
    reload(id: string) {
      invalidate([id]);
    },
    dispose() {
      disposed = true;
      stop();
      invalidate(metadata().plugins.map((p) => p.plugin.id));
    },
  };
}
export type PluginLoader = ReturnType<typeof createPluginLoader>;

export function expandImporters(
  affected: Set<string>,
  importers: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const queue = [...affected];
  for (let index = 0; index < queue.length; index++) {
    for (const name of importers.get(queue[index]!) ?? []) {
      if (!affected.has(name)) {
        affected.add(name);
        queue.push(name);
      }
    }
  }
}
