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
  createEffect(() => {
    const contributions = ["fill", "wrap", "replace"].flatMap((kind) =>
      props.host.contributions(kind as "fill" | "wrap" | "replace"),
    );
    for (const c of contributions) props.host.version(c.plugin);
    let alive = true;
    const failed = new Set<string>();
    const stops = [...new Set(contributions.map((c) => c.plugin))].map((id) =>
      props.host.onError(id, (cause) => {
        failed.add(id);
        setLoaded((previous) => previous.filter((c) => c.plugin !== id));
        warn(`Extension ${id} failed: ${String(cause)}`);
      }),
    );
    onCleanup(() => {
      alive = false;
      for (const stop of stops) stop();
    });
    setLoaded([]);
    void Promise.all(
      contributions.map(async (c) => {
        try {
          const exports = await props.host.load(c.plugin);
          const component = exports[c.id];
          return typeof component === "function" ? ({ ...c, component } as Loaded) : undefined;
        } catch (error) {
          warn(`Extension ${c.plugin}/${c.id} failed: ${String(error)}`);
          return undefined;
        }
      }),
    ).then((values) => {
      if (alive) setLoaded(values.filter((v): v is Loaded => !!v && !failed.has(v.plugin)));
    });
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
        <ErrorBoundary fallback={() => null}>{createComponent(fill.component, props.props)}</ErrorBoundary>
      )}
    </For>
  );
}

/** Compiler-inserted identity at public component declarations, including local
 * calls. The original implementation is private to this component's fallback. */
export function publicComponent<P extends object>(name: string, original: Component<P>): Component<P> {
  return (props) => {
    const extensions = useContext(Extensions);
    const composed = createMemo(() => {
      let result = original;
      let replaced = false;
      for (const mod of extensions()
        .filter((c) => c.options.target === name && c.kind !== "fill")
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
