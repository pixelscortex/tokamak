/** Client extension points share the shell's owner and plugin generations. */
import {
  ErrorBoundary,
  For,
  Show,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  useContext,
  mergeProps,
  untrack,
  type Component,
} from "solid-js";
import { createComponent, warn, type JSX } from "@tokamak/render";
import { contributionBrand } from "./src/contributions";
export { useClient, useQuery } from "./solid";

export interface SlotDefinition<P extends object> {
  readonly name: string;
  readonly props?: P;
}
export function defineSlot<P extends object>(name: string): SlotDefinition<P> {
  return { name };
}
export function fill<P extends object>(
  slot: SlotDefinition<P>,
  options: { order?: number; id?: string },
  component: Component<P>,
) {
  return Object.assign(component, { [contributionBrand]: "fill" as const, options, target: slot.name });
}
export function wrap<P extends object>(
  target: Component<P>,
  wrapper: (Original: Component<P>) => Component<P>,
) {
  return Object.assign(wrapper, { [contributionBrand]: "wrap" as const, target });
}
export function replace<P extends object>(target: Component<P>, replacement: Component<P>) {
  return Object.assign(replacement, { [contributionBrand]: "replace" as const, target });
}

export interface ExtensionContribution {
  plugin: string;
  id: string;
  kind: string;
  options: Readonly<Record<string, string | number>>;
}
export interface ExtensionHost {
  contributions(kind: "fill" | "wrap" | "replace"): ExtensionContribution[];
  version(id: string): number;
  load(id: string): Promise<Record<string, unknown>>;
  onError(id: string, listener: (cause: unknown) => void): () => void;
}
type Loaded = ExtensionContribution & { component: (...args: any[]) => any };
const Extensions = createContext<() => Loaded[]>(() => []);

/** Catalog discovery loads only extension contributors. Removing a plugin clears
 * its layers synchronously; late loads cannot publish into a retired owner. */
export function ExtensionProvider(props: { host: ExtensionHost; children?: JSX.Element }) {
  const [loaded, setLoaded] = createSignal<Loaded[]>([]);
  const plugins = new Map<string, { version: number; stop(): void }>();
  onCleanup(() => {
    for (const plugin of plugins.values()) plugin.stop();
    plugins.clear();
  });
  createEffect(() => {
    const contributions = ["fill", "wrap", "replace"].flatMap((kind) =>
      props.host.contributions(kind as "fill" | "wrap" | "replace"),
    );
    const groups = new Map<string, ExtensionContribution[]>();
    for (const c of contributions) {
      const group = groups.get(c.plugin) ?? [];
      group.push(c);
      groups.set(c.plugin, group);
    }
    for (const [id, plugin] of plugins) {
      if (!groups.has(id) || plugin.version !== props.host.version(id)) {
        plugin.stop();
        plugins.delete(id);
        setLoaded((previous) => previous.filter((c) => c.plugin !== id));
      }
    }
    for (const [id, group] of groups) {
      const version = props.host.version(id);
      if (plugins.has(id)) continue;
      let failed = false;
      const plugin = {
        version,
        stop: props.host.onError(id, (cause) => {
          failed = true;
          setLoaded((previous) => previous.filter((c) => c.plugin !== id));
          warn(`Extension ${id} failed: ${String(cause)}`);
        }),
      };
      plugins.set(id, plugin);
      void props.host.load(id).then(
        (exports) => {
          if (plugins.get(id) !== plugin || failed) return;
          const values = group.flatMap((c) => {
            const component = exports[c.id];
            return typeof component === "function" ? [{ ...c, component } as Loaded] : [];
          });
          setLoaded((previous) => [...previous, ...values]);
        },
        (cause) => warn(`Extension ${id} failed: ${String(cause)}`),
      );
    }
  });
  return <Extensions.Provider value={loaded}>{props.children}</Extensions.Provider>;
}
export function Slot<P extends object>(props: { of: SlotDefinition<P>; props: P }) {
  const extensions = useContext(Extensions);
  const fills = createMemo(() =>
    extensions()
      .filter((c) => c.kind === "fill" && c.options.target === props.of.name)
      .sort(
        (a, b) =>
          Number(a.options.order ?? 0) - Number(b.options.order ?? 0) ||
          a.plugin.localeCompare(b.plugin) ||
          String(a.options.fillId ?? a.id).localeCompare(String(b.options.fillId ?? b.id)),
      ),
  );
  return (
    <For each={fills()}>
      {(fill) => (
        <ErrorBoundary fallback={() => null}>
          {untrack(() =>
            createComponent(
              fill.component,
              mergeProps(() => props.props),
            ),
          )}
        </ErrorBoundary>
      )}
    </For>
  );
}

/** Compiler-inserted identity at public component declarations, including local
 * calls. The original implementation is private to this component's fallback. */
export function publicComponent<P extends object>(
  name: string | readonly string[],
  original: Component<P>,
): Component<P> {
  return (props) => {
    const extensions = useContext(Extensions);
    const composed = createMemo(() => {
      let result = original;
      let replaced = false;
      for (const mod of extensions()
        .filter(
          (c) =>
            (typeof name === "string" ? [name] : name).includes(String(c.options.target)) &&
            c.kind !== "fill",
        )
        .sort((a, b) =>
          a.kind === b.kind
            ? a.plugin.localeCompare(b.plugin) || a.id.localeCompare(b.id)
            : a.kind === "replace"
              ? -1
              : 1,
        )) {
        if (mod.kind === "replace") {
          if (replaced) {
            warn(`Ignoring second replacement for ${name}: ${mod.plugin}/${mod.id}`);
            continue;
          }
          replaced = true;
        }
        const inner = result;
        result = (p) => (
          <ErrorBoundary fallback={() => createComponent(inner, p)}>
            {mod.kind === "wrap"
              ? createComponent(mod.component(inner), p)
              : createComponent(mod.component, p)}
          </ErrorBoundary>
        );
      }
      return result;
    });
    return (
      <Show keyed when={composed()}>
        {(component: Component<P>) => createComponent(component, props)}
      </Show>
    );
  };
}

/** Registrations belong to the calling plugin owner, even when its view leaves. */
export interface Shortcuts {
  registerShortcut(key: string, handler: () => void): () => void;
}
export const ShortcutContext = createContext<Shortcuts>();
export function useShortcuts(): Shortcuts {
  const shortcuts = useContext(ShortcutContext);
  if (!shortcuts) throw new Error("Plugin UI requires shell shortcuts");
  return shortcuts;
}
