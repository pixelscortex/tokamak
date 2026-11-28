/** Client extension points share the shell's owner and plugin generations. */
import { createEffect, createContext, createSignal, onCleanup, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { componentActionKind, isComponentAction, type ComponentAction } from "./component-actions";
export {
  before,
  after,
  prepend,
  append,
  attrs,
  hide,
  layer,
  attach,
  type OriginalElement,
  type ElementAttributes,
  type ComponentAttributes,
  type ComponentPart,
  type RenderFunction,
  type ScreenFind,
  type ComponentActionOptions,
} from "./component-actions";
import {
  flattenAttributes,
  resolveScreenSearch,
  screenElements,
  screenTarget,
  type ScreenElement,
  type ScreenSearch,
  type ScreenTree,
} from "./screen-search";
import { componentAlerts } from "./component-alerts";
import type { AttributeWarning } from "./component-attributes";
export type { AttributeWarning } from "./component-attributes";
import {
  compareInstallOrder,
  PartActions,
  type LoadedPartAction,
  type PartObserver,
  type PartRegistry,
} from "./component-parts";
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
type MountedAddon = {
  signature: string;
  catalog: string;
  failed: boolean;
  ready?: Promise<LoadedPartAction[]>;
  stop(): void;
};

const partOwner = ({ options }: ExtensionContribution) =>
  typeof options.owner === "string" ? options.owner : String(options.target).split(".")[0]!;

/** Catalog discovery loads only extension contributors. Removing a plugin clears
 * its layers synchronously; late loads cannot publish into a retired owner. */
export function ExtensionProvider(props: {
  host: ExtensionHost;
  onAlerts?: (messages: readonly string[]) => void;
  onAttributeWarning?: (warning: AttributeWarning) => void;
  children?: JSX.Element;
}) {
  const slots = new Map<string, ReturnType<typeof createSignal<readonly LoadedPartAction[]>>>();
  const current = new Map<string, readonly LoadedPartAction[]>();
  const observers = new Map<string, Set<PartObserver>>();
  function slot(target: string) {
    let signal = slots.get(target);
    if (!signal)
      slots.set(
        target,
        (signal = createSignal<readonly LoadedPartAction[]>(current.get(target) ?? [], { ownedWrite: true })),
      );
    return signal;
  }

  const alerts = componentAlerts(
    (messages) => props.onAlerts?.(messages),
    (warning) => props.onAttributeWarning?.(warning),
    (message) => console.warn(message),
  );
  const ownerTrees = new Map<string, () => ReadonlySet<string>>();
  const insideSlots = new Map<string, ReturnType<typeof createSignal<readonly LoadedPartAction[]>>>();
  function inOwnerTree(target: string) {
    return ownerTrees.get(target.split(".")[0]!)?.().has(target) ?? true;
  }
  function inside(target: string) {
    let signal = insideSlots.get(target);
    if (!signal) {
      // Packed addresses encode ancestry. Intersect the owner's tree with the
      // installed targets once per watched address, not once per mounted row.
      const actions = [...current].flatMap(([key, items]) =>
        key.startsWith(`${target}.`) && inOwnerTree(key) ? items : [],
      );
      insideSlots.set(
        target,
        (signal = createSignal<readonly LoadedPartAction[]>(actions, { ownedWrite: true })),
      );
    }
    return signal[0]();
  }

  const registry: PartRegistry = {
    warn: alerts.warn,
    mismatch: alerts.mismatch,
    failure: alerts.failure,
    interference: alerts.interference,
    inside,
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
    if (insideSlots.size && inOwnerTree(target)) {
      for (let end = target.lastIndexOf("."); end !== -1; end = target.lastIndexOf(".", end - 1)) {
        insideSlots.get(target.slice(0, end))?.[1]((items) => [
          ...items.filter((item) => item.action.target !== target),
          ...next,
        ]);
      }
    }
    slots.get(target)?.[1](next);
    for (const observer of observers.get(target) ?? []) observer.update(next);
  }

  const plugins = new Map<string, MountedAddon>();
  const targets = new Map<string, Set<string>>();
  function clear(id: string) {
    alerts.clear(id);
    for (const target of targets.get(id) ?? [])
      update(target, (items) => items.filter((c) => c.plugin !== id));
    targets.delete(id);
  }

  function publish(id: string, parts: LoadedPartAction[]) {
    const group = new Map<string, LoadedPartAction[]>();
    for (const part of parts) {
      const target = part.action.target;
      let items = group.get(target);
      if (!items) group.set(target, (items = []));
      items.push(part);
    }
    for (const target of group.keys()) remember(id, target);
    for (const [target, added] of group)
      update(target, (items) =>
        [...items, ...added].sort(
          (a, b) => a.order - b.order || a.plugin.localeCompare(b.plugin) || a.id.localeCompare(b.id),
        ),
      );
  }
  function remember(id: string, target: string) {
    let owned = targets.get(id);
    if (!owned) targets.set(id, (owned = new Set()));
    owned.add(target);
  }
  onCleanup(() => {
    for (const plugin of plugins.values()) plugin.stop();
    plugins.clear();
  });
  // Resolve historical addresses against the current owner before loading additions.
  let generation = 0;
  let versions = new Map<string, number>();
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
      // Resolving against a new owner retires bindings, but the failing
      // add-on is still installed at the same generation.
      const nextVersions = new Map(contributions.map(({ plugin, version }) => [plugin, version]));
      for (const [id, version] of versions) if (nextVersions.get(id) !== version) alerts.clear(id, true);
      versions = nextVersions;
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
              parts: typeof owner?.find === "function" ? authoredParts.get(owner.find) : undefined,
              legacy: owner?.parts,
            },
          ]),
        );
        ownerTrees.clear();
        for (const [id, { parts }] of owners) {
          if (!parts) continue;
          let addresses: Set<string> | undefined;
          ownerTrees.set(
            id,
            () =>
              (addresses ??= new Set(
                [...parts("element"), ...parts("render function")].map((p) => p.target),
              )),
          );
        }
        const rejected: string[] = [];
        const valid = contributions.flatMap((c): CatalogExtension[] => {
          const target = screenTarget(c.options);
          const owner = owners.get(partOwner(c));
          if (!owner?.parts && !owner?.legacy) return [c];
          const kind = c.options.action === "attach" ? "render function" : "element";
          const result =
            owner.parts || kind === "render function"
              ? resolveScreenSearch(owner.parts?.(kind) ?? [], target.search, target, kind)
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
    alerts.skipped(rejected);

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
      const plugin: MountedAddon = {
        signature: signatures.get(id)!,
        catalog: catalog.get(id)!,
        failed: false,
        stop: () => {},
      };
      plugins.set(id, plugin);
      plugin.stop = props.host.onError(id, (cause) => {
        plugin.failed = true;
        clear(id);
        console.warn(`Extension ${id} failed: ${String(cause)}`);
      });
      plugin.ready = props.host.load(id).then(
        (exports) => {
          if (plugins.get(id) !== plugin || plugin.failed) return [];
          const parts: LoadedPartAction[] = [];
          const attachments: LoadedPartAction[] = [];
          for (const c of group) {
            const value = exports[c.id];
            if (
              isComponentAction(value) &&
              value.target === c.options.target &&
              componentActionKind(value) === c.options.action
            ) {
              (c.options.action === "attach" ? attachments : parts).push(loadedPart(c, value, registry));
            } else {
              console.warn(
                `Component action ${id}/${c.id} does not match its manifest: expected ${c.options.action} for ${c.options.target}`,
              );
            }
          }
          if (parts.length) publish(id, parts);
          return attachments;
        },
        (cause) => {
          console.warn(`Extension ${id} failed: ${String(cause)}`);
          return [];
        },
      );
    }
    const attachments = new Map<string, Set<MountedAddon>>();
    for (const c of contributions) {
      if (c.options.action !== "attach") continue;
      const target = c.resolved?.target ?? String(c.options.target);
      let addons = attachments.get(target);
      if (!addons) attachments.set(target, (addons = new Set()));
      addons.add(plugins.get(c.plugin)!);
    }
    const revision = generation;
    for (const [target, addons] of attachments) {
      // Start attachments on a target together so import timing cannot set
      // their order. Placements and attachments on other targets do not wait.
      void Promise.all([...addons].map(async (addon) => ({ addon, items: await addon.ready }))).then(
        (ready) => {
          if (revision !== generation) return;
          const parts = ready
            .flatMap(({ addon, items }) =>
              addon.failed ? [] : (items ?? []).filter((item) => item.action.target === target),
            )
            .sort(compareInstallOrder);
          for (const part of parts) remember(part.plugin, target);
          const previous = current.get(target) ?? [];
          if (parts.length !== previous.length || parts.some((part, i) => part !== previous[i]))
            update(target, () => parts);
        },
      );
    }
  }
  return <PartActions value={registry}>{props.children}</PartActions>;
}

function callableAttributes(value: unknown): ReadonlySet<string> | undefined {
  if (typeof value !== "string") return;
  try {
    const names: unknown = JSON.parse(value);
    if (Array.isArray(names) && names.every((name) => typeof name === "string")) return new Set(names);
  } catch {
    // The build supplies this metadata. Ignore malformed older manifests.
  }
}

function loadedPart(c: CatalogExtension, action: ComponentAction, registry: PartRegistry): LoadedPartAction {
  const item: LoadedPartAction = {
    id: c.id,
    plugin: c.plugin,
    order: Number(c.options.order ?? 0),
    installOrder: c.installOrder,
    callableAttributes: callableAttributes(c.options.callableAttributes),
    action: c.resolved ? { ...action, target: c.resolved.target } : action,
    fingerprint: c.resolved ? c.resolved.fingerprint : screenTarget(c.options).fingerprint,
    enabled(props) {
      try {
        return action.when?.(props) ?? true;
      } catch (cause) {
        registry.failure(item, cause, `Component action ${c.plugin}/${c.id} failed: ${String(cause)}`);
        return false;
      }
    },
  };
  return item;
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
  attachRenderFunction as __attachRenderFunction,
  renderPart as __renderPart,
  renderPlainPart as __renderPlainPart,
  renderComponentPart as __renderComponentPart,
  renderNativePart as __renderNativePart,
  renderNativeText as __renderNativeText,
} from "./component-parts";

type ScreenKind = NonNullable<Parameters<typeof screenElements>[2]>;
const authoredParts = new WeakMap<object, (kind: ScreenKind) => ReturnType<typeof screenElements>>();

/** Generated by the client compiler. Production calls are resolved during the build. */
export function __defineScreenFind(plugin: string, packedTree: string) {
  let tree: ScreenTree | undefined;
  const cache = new Map<ScreenKind, ReturnType<typeof screenElements>>();
  function read(kind: ScreenKind) {
    let parts = cache.get(kind);
    if (!parts) cache.set(kind, (parts = screenElements(plugin, (tree ??= JSON.parse(packedTree)), kind)));
    return parts;
  }
  function find(name: string, filters?: Omit<ScreenSearch, "name">) {
    const search = { name, ...filters };
    const element = resolveScreenSearch(read("element"), search);
    const render = resolveScreenSearch(read("render function"), search, undefined, "render function");
    if (element.element) return { target: element.element.target, renderTarget: render.element?.target };
    if (render.element) return { target: render.element.target };
    throw new Error(element.reason);
  }
  authoredParts.set(find, read);
  return find;
}

function resolveLegacyPart(node: unknown, owner: string, target: ReturnType<typeof screenTarget>) {
  // A legacy owner has paths but no attributes to verify a filtered search.
  if (target.search && flattenAttributes(target.search).length)
    return resolveScreenSearch([], target.search, target);
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
