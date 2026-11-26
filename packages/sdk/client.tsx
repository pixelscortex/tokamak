/** Client extension points share the shell's owner and plugin generations. */
import { createEffect, createContext, createSignal, onCleanup, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { componentActionKind, isComponentAction, type ComponentAction } from "./component-actions";
export {
  before,
  after,
  prepend,
  append,
  hide,
  layer,
  type OriginalElement,
  type ComponentPart,
  type ScreenFind,
  type ComponentActionOptions,
} from "./component-actions";
import {
  resolveScreenSearch,
  screenElements,
  screenTarget,
  type ScreenElement,
  type ScreenSearch,
  type ScreenTree,
} from "./screen-search";
import { PartActions, type LoadedPartAction, type PartObserver, type PartRegistry } from "./component-parts";
export { auth, useClient, useQuery } from "./solid";
export { onQuit, quitBlockers, type QuitBlocker, type QuitCheck } from "./quit";
export { state, derived, type StateOptions, type WindowDerived, type WindowState } from "./window-state";
export { view, viewRoute, type ViewOptions } from "./view";

export interface ExtensionContribution {
  plugin: string;
  id: string;
  kind: string;
  options: Readonly<Record<string, string | number>>;
  installOrder?: number;
}
export interface ExtensionHost {
  contributions(kind: "component-action"): ExtensionContribution[];
  version(id: string): number;
  load(id: string): Promise<Record<string, unknown>>;
  partOwner?(id: string): Promise<Record<string, unknown> | undefined>;
  onError(id: string, listener: (cause: unknown) => void): () => void;
}
type CatalogExtension = ExtensionContribution & {
  version: number;
  ownerVersion: number;
  resolved?: ScreenElement;
};

const partOwner = ({ options }: ExtensionContribution) =>
  typeof options.owner === "string" ? options.owner : String(options.target).split(".")[0]!;

/** Catalog discovery loads only extension contributors. Removing a plugin clears
 * its layers synchronously; late loads cannot publish into a retired owner. */
export function ExtensionProvider(props: {
  host: ExtensionHost;
  onAlerts?: (messages: readonly string[]) => void;
  children?: JSX.Element;
}) {
  const slots = new Map<string, ReturnType<typeof createSignal<readonly LoadedPartAction[]>>>();
  const current = new Map<string, readonly LoadedPartAction[]>();
  const observers = new Map<string, Set<PartObserver>>();
  function slot(target: string) {
    let signal = slots.get(target);
    if (!signal)
      slots.set(target, (signal = createSignal<readonly LoadedPartAction[]>([], { ownedWrite: true })));
    return signal;
  }

  let reported = new Set<string>();
  const stale = new Map<string, string>();
  function alerts() {
    props.onAlerts?.([...reported, ...stale.values()]);
  }

  function warnStale(plugin: string, target: string, reason: string) {
    const key = JSON.stringify([plugin, target]);
    if (stale.has(key)) return;
    const message = `Plugin "${plugin}": ${reason} ${target}; skipping this addition`;
    stale.set(key, message);
    console.warn(message);
    alerts();
  }

  const layerWarnings = new Map<string, Set<string>>();
  const registry: PartRegistry = {
    warn(key, message) {
      const [kind, plugin, target] = key;
      let warnings = layerWarnings.get(plugin);
      if (!warnings) layerWarnings.set(plugin, (warnings = new Set()));
      const id = JSON.stringify([kind, target]);
      if (warnings.has(id)) return;
      warnings.add(id);
      console.warn(message);
    },
    mismatch: (plugin, target) => warnStale(plugin, target, "targets a different element at"),
    read: (target) => slot(target)[0],
    observe(target, observer) {
      let listeners = observers.get(target);
      if (!listeners) observers.set(target, (listeners = new Set()));
      listeners.add(observer);
      if (current.size) {
        const actions = current.get(target);
        if (actions) observer.update(actions);
      }
    },
    unobserve(target, observer) {
      const listeners = observers.get(target);
      listeners?.delete(observer);
      if (!listeners?.size) observers.delete(target);
    },
  };
  function update(
    target: string,
    change: (items: readonly LoadedPartAction[]) => readonly LoadedPartAction[],
  ) {
    const next = change(current.get(target) ?? []);
    if (next.length) current.set(target, next);
    else current.delete(target);
    slot(target)[1](next);
    for (const observer of observers.get(target) ?? []) observer.update(next);
  }

  const plugins = new Map<string, { signature: string; catalog: string; stop(): void }>();
  const targets = new Map<string, Set<string>>();
  function clear(id: string) {
    for (const target of targets.get(id) ?? [])
      update(target, (items) => items.filter((c) => c.plugin !== id));
    targets.delete(id);
    layerWarnings.delete(id);

    // A reloaded add-on reports its stale targets again; a removed one has none.
    let forgotten = false;
    for (const key of stale.keys()) if (JSON.parse(key)[0] === id) forgotten = stale.delete(key) || forgotten;
    if (forgotten) alerts();
  }

  function publish(id: string, parts: LoadedPartAction[]) {
    const group = new Map<string, LoadedPartAction[]>();
    for (const part of parts) {
      const target = part.action.target;
      let items = group.get(target);
      if (!items) group.set(target, (items = []));
      items.push(part);
    }
    targets.set(id, new Set(group.keys()));
    for (const [target, added] of group)
      update(target, (items) =>
        [...items, ...added].sort(
          (a, b) => a.order - b.order || a.plugin.localeCompare(b.plugin) || a.id.localeCompare(b.id),
        ),
      );
  }
  onCleanup(() => {
    for (const plugin of plugins.values()) plugin.stop();
    plugins.clear();
  });
  // Resolve historical addresses against the current owner before loading additions.
  let generation = 0;
  onCleanup(() => generation++);
  createEffect(
    () =>
      props.host.contributions("component-action").map((contribution) => ({
        ...contribution,
        version: props.host.version(contribution.plugin),
        ownerVersion: props.host.version(partOwner(contribution)),
      })),
    (contributions) => {
      const revision = ++generation;
      const previous = new Map<string, string>();
      for (const c of contributions)
        previous.set(c.plugin, (previous.get(c.plugin) ?? "") + JSON.stringify(c));
      for (const [id, plugin] of plugins) {
        if (plugin.catalog !== previous.get(id)) {
          plugin.stop();
          plugins.delete(id);
          clear(id);
        }
      }
      if (!props.host.partOwner) return apply(contributions, previous, []);
      const ids = new Set(contributions.map(partOwner));
      if (!ids.size) return apply(contributions, previous, []);
      void Promise.all(
        [...ids].map(async (id) => {
          try {
            const owner = await props.host.partOwner!(id);
            return [id, owner] as const;
          } catch {
            // The next catalog generation rechecks an owner that is not available yet.
            return [id, undefined] as const;
          }
        }),
      ).then((entries) => {
        if (revision !== generation) return;
        const owners = new Map(
          entries.map(([id, owner]) => [
            id,
            {
              elements: typeof owner?.find === "function" ? authoredElements.get(owner.find)?.() : undefined,
              legacy: owner?.parts,
            },
          ]),
        );
        const rejected: string[] = [];
        const valid = contributions.flatMap((c): CatalogExtension[] => {
          const target = screenTarget(c.options);
          const owner = owners.get(partOwner(c));
          if (!owner?.elements && !owner?.legacy) return [c];
          const result = owner.elements
            ? resolveScreenSearch(owner.elements, target.search, target)
            : resolveLegacyPart(owner.legacy, partOwner(c), target);
          if (!result.element) {
            rejected.push(`Plugin "${c.plugin}": ${result.reason}; skipping this addition`);
            return [];
          }
          const { target: path, fingerprint } = result.element;
          return [{ ...c, resolved: { target: path, fingerprint } }];
        });
        apply(valid, previous, rejected);
      });
    },
  );

  function apply(contributions: CatalogExtension[], catalog: Map<string, string>, rejected: string[]) {
    const skipped = new Set(rejected);
    for (const message of skipped) if (!reported.has(message)) console.warn(message);
    const changed = skipped.size !== reported.size || [...skipped].some((message) => !reported.has(message));
    reported = skipped;
    if (changed) alerts();

    const groups = new Map<string, CatalogExtension[]>();
    for (const c of contributions) {
      const group = groups.get(c.plugin) ?? [];
      group.push(c);
      groups.set(c.plugin, group);
    }
    const signatures = new Map([...groups].map(([id, group]) => [id, JSON.stringify(group)]));
    for (const [id, plugin] of plugins) {
      if (plugin.signature !== signatures.get(id)) {
        plugin.stop();
        plugins.delete(id);
        clear(id);
      }
    }
    for (const [id, group] of groups) {
      if (plugins.has(id)) continue;
      let failed = false;
      const plugin = {
        signature: signatures.get(id)!,
        catalog: catalog.get(id)!,
        stop: props.host.onError(id, (cause) => {
          failed = true;
          clear(id);
          console.warn(`Extension ${id} failed: ${String(cause)}`);
        }),
      };
      plugins.set(id, plugin);
      void props.host.load(id).then(
        (exports) => {
          if (plugins.get(id) !== plugin || failed) return;
          const parts: LoadedPartAction[] = [];
          for (const c of group) {
            const value = exports[c.id];
            if (
              isComponentAction(value) &&
              value.target === c.options.target &&
              componentActionKind(value) === c.options.action
            ) {
              parts.push(loadedPart(c, value));
            } else {
              console.warn(
                `Component action ${id}/${c.id} does not match its manifest: expected ${c.options.action} for ${c.options.target}`,
              );
            }
          }
          if (parts.length) publish(id, parts);
        },
        (cause) => console.warn(`Extension ${id} failed: ${String(cause)}`),
      );
    }
  }
  return <PartActions value={registry}>{props.children}</PartActions>;
}

function loadedPart(c: CatalogExtension, action: ComponentAction): LoadedPartAction {
  let warned = false;
  return {
    id: c.id,
    plugin: c.plugin,
    order: Number(c.options.order ?? 0),
    installOrder: c.installOrder,
    action: c.resolved ? { ...action, target: c.resolved.target } : action,
    fingerprint: c.resolved ? c.resolved.fingerprint : screenTarget(c.options).fingerprint,
    enabled(props) {
      try {
        return action.when?.(props) ?? true;
      } catch (cause) {
        if (!warned) console.warn(`Component action ${c.plugin}/${c.id} failed: ${String(cause)}`);
        warned = componentActionKind(action) === "layer";
        return false;
      }
    },
  };
}

/** Registrations belong to the calling plugin owner, even when its view leaves. */
export interface Shortcuts {
  /**
   * Runs `handler` on `key` ("Meta+n", "1"). A handler that returns `false`
   * declines this press (say, its field holds text): when every handler
   * declines, the key goes on as if nothing were registered.
   */
  registerShortcut(key: string, handler: () => void | boolean): () => void;
}
export const ShortcutContext = createContext<Shortcuts>();
export function useShortcuts(): Shortcuts {
  const shortcuts = useContext(ShortcutContext);
  if (!shortcuts) throw new Error("Plugin UI requires shell shortcuts");
  return shortcuts;
}

export {
  Region,
  RegionOutlet,
  RegionProvider,
  useRegionFilled,
  usePageTitle,
  usePageTitleValue,
  type RegionName,
} from "./regions";

export {
  renderPart as __renderPart,
  renderNativePart as __renderNativePart,
  renderNativeText as __renderNativeText,
} from "./component-parts";

const authoredElements = new WeakMap<object, () => ReturnType<typeof screenElements>>();

/** Generated by the client compiler. Production calls are resolved during the build. */
export function __defineScreenFind(plugin: string, packedTree: string) {
  let elements: ReturnType<typeof screenElements> | undefined;
  const read = () => (elements ??= screenElements(plugin, JSON.parse(packedTree) as ScreenTree));
  function find(name: string, filters?: Omit<ScreenSearch, "name">) {
    const result = resolveScreenSearch(read(), { name, ...filters });
    if (!result.element) throw new Error(result.reason);
    return { target: result.element.target };
  }
  authoredElements.set(find, read);
  return find;
}

function resolveLegacyPart(node: unknown, owner: string, target: ReturnType<typeof screenTarget>) {
  for (const key of target.target.slice(owner.length + 1).split("."))
    node =
      node && typeof node === "object" && Object.hasOwn(node, key)
        ? (node as Record<string, unknown>)[key]
        : undefined;
  const part = node as typeof target | undefined;
  return resolveScreenSearch(
    part?.target === target.target ? [{ ...part, name: "", ancestors: [] }] : [],
    undefined,
    target,
  );
}

/** Existing owner bundles call this until they are rebuilt. */
export function __defineScreenParts(prefix: string, shape: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shape)) {
    if (key === "") {
      result.target = prefix;
      if (value) result.fingerprint = value;
    } else if (value && typeof value === "object") {
      result[key] = __defineScreenParts(`${prefix}.${key}`, value as Record<string, unknown>);
    }
  }
  return result;
}

export function __partPaths(prefix: string, suffixes: readonly string[]) {
  return suffixes.map((suffix) => (suffix ? `${prefix}.${suffix}` : prefix));
}
