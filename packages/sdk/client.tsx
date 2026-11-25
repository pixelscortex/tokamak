/** Client extension points share the shell's owner and plugin generations. */
import { createEffect, createContext, createMemo, createSignal, onCleanup, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { componentActionKind, isComponentAction, type ComponentAction } from "./component-actions";
export {
  before,
  after,
  prepend,
  append,
  hide,
  wrapPart as wrap,
  replacePart as replace,
  type ComponentPart,
  type ComponentActionOptions,
} from "./component-actions";
import { PartActions, type LoadedPartAction } from "./component-parts";
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
  onError(id: string, listener: (cause: unknown) => void): () => void;
}
type CatalogExtension = ExtensionContribution & { version: number };

/** Catalog discovery loads only extension contributors. Removing a plugin clears
 * its layers synchronously; late loads cannot publish into a retired owner. */
export function ExtensionProvider(props: {
  host: ExtensionHost;
  onAlerts?: (messages: readonly string[]) => void;
  children?: JSX.Element;
}) {
  const [partActions, setPartActions] = createSignal<LoadedPartAction[]>([], { ownedWrite: true });
  const plugins = new Map<string, { signature: string; stop(): void }>();
  let reported = new Set<string>();
  function clear(id: string) {
    setPartActions((previous) => previous.filter((c) => c.plugin !== id));
  }
  onCleanup(() => {
    for (const plugin of plugins.values()) plugin.stop();
    plugins.clear();
  });
  createEffect(
    () =>
      props.host.contributions("component-action").map((contribution) => ({
        ...contribution,
        version: props.host.version(contribution.plugin),
      })),
    (contributions) => {
      const { accepted, refused } = resolveReplacements(contributions);
      for (const message of refused) if (!reported.has(message)) console.warn(message);
      if (refused.size !== reported.size || [...refused].some((message) => !reported.has(message))) {
        props.onAlerts?.([...refused]);
      }
      reported = refused;

      const groups = new Map<string, CatalogExtension[]>();
      for (const c of accepted) {
        const group = groups.get(c.plugin) ?? [];
        group.push(c);
        groups.set(c.plugin, group);
      }
      // A competing replacement can change the accepted exports without changing
      // this plugin's version. Include the accepted catalog entries as well.
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
            if (parts.length) setPartActions((previous) => [...previous, ...parts]);
          },
          (cause) => console.warn(`Extension ${id} failed: ${String(cause)}`),
        );
      }
    },
  );
  const byTarget = createMemo(() => {
    const result = new Map<string, LoadedPartAction[]>();
    for (const action of partActions()) {
      const values = result.get(action.action.target) ?? [];
      values.push(action);
      result.set(action.action.target, values);
    }
    for (const values of result.values()) {
      values.sort(
        (a, b) => a.order - b.order || a.plugin.localeCompare(b.plugin) || a.id.localeCompare(b.id),
      );
    }
    return result;
  });
  return <PartActions value={(target) => byTarget().get(target) ?? []}>{props.children}</PartActions>;
}

function loadedPart(c: ExtensionContribution, action: ComponentAction): LoadedPartAction {
  return {
    id: c.id,
    plugin: c.plugin,
    order: Number(c.options.order ?? 0),
    action,
    enabled(props) {
      try {
        return action.when?.(props) ?? true;
      } catch (cause) {
        console.warn(`Component action ${c.plugin}/${c.id} failed: ${String(cause)}`);
        return false;
      }
    },
  };
}

function isReplacement(c: ExtensionContribution) {
  return c.kind === "component-action" && c.options.action === "replace";
}

function resolveReplacements(contributions: CatalogExtension[]) {
  const winners = new Map<string, CatalogExtension>();
  const refused = new Set<string>();
  // Resolve from the catalog, before any module loads or when accessors run.
  for (const c of contributions) {
    if (!isReplacement(c)) continue;
    const target = String(c.options.target);
    const first = winners.get(target);
    if (!first || (c.installOrder ?? Infinity) < (first.installOrder ?? Infinity)) winners.set(target, c);
  }
  const accepted = contributions.filter((c) => {
    if (!isReplacement(c)) return true;
    const winner = winners.get(String(c.options.target))!;
    if (winner === c) return true;
    refused.add(
      `Replacement from ${c.plugin} (${c.id}) refused for ${c.options.target}: ${winner.plugin} (${winner.id}) installed first`,
    );
    return false;
  });
  return { accepted, refused };
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

export { renderPart as __renderPart } from "./component-parts";
