import {
  createComponent,
  createContext,
  createMemo,
  Errored,
  For,
  merge,
  Show,
  untrack,
  useContext,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  componentActionKind,
  PartProps,
  type ComponentAction,
  type ComponentActionKind,
} from "./component-actions";

export interface PartAdditions {
  readonly prepend: JSX.Element;
  readonly append: JSX.Element;
}

export interface LoadedPartAction {
  id: string;
  plugin: string;
  order: number;
  action: ComponentAction;
  /** Reads the action's `when` with the props of the component that owns the element. */
  enabled(props: object): boolean;
}
export const PartActions = createContext<(target: string) => readonly LoadedPartAction[]>(() => []);

/** Compiler entry point. Keep the original element and contents lazy so hiding
 * or replacing the element disposes its entire Solid owner. */
export function renderPart(
  target: string | null,
  render: (contents: (override?: () => JSX.Element) => JSX.Element) => JSX.Element,
  original?: () => JSX.Element,
  place?: (added: PartAdditions) => JSX.Element,
): JSX.Element {
  const actions = useContext(PartActions);
  const props = useContext(PartProps);
  const at = (kind: ComponentActionKind) =>
    target === null ? [] : actions(target).filter((item) => componentActionKind(item.action) === kind);
  const enabled = (item: LoadedPartAction) => item.enabled(props);
  const hidden = createMemo(() => at("hide").some(enabled));
  const replacement = createMemo(() => at("replace").find(enabled) ?? null);
  const wrappers = createMemo(() => at("wrap"), {
    equals: (before, after) =>
      !!before && before.length === after.length && before.every((item, i) => item === after[i]),
  });

  function additions(kind: "before" | "after" | "prepend" | "append") {
    return (
      <For each={at(kind)}>
        {(item) => (
          <Show when={enabled(item)}>
            <Errored fallback={() => null}>
              {untrack(() => createComponent(item.action.layer!, props))}
            </Errored>
          </Show>
        )}
      </For>
    );
  }
  function contents(override = original) {
    return place ? (
      place({
        get prepend() {
          return additions("prepend");
        },
        get append() {
          return additions("append");
        },
      })
    ) : (
      <>
        {additions("prepend")}
        {override?.()}
        {additions("append")}
      </>
    );
  }
  function surround(wrapper: LoadedPartAction, inner: JSX.Element): JSX.Element {
    // Keep the inner layers outside this branch so toggling a wrapper only
    // moves their nodes and does not dispose their owners.
    return (
      <Show when={enabled(wrapper)} fallback={inner}>
        <Errored fallback={() => inner}>
          {untrack(() =>
            createComponent(
              wrapper.action.layer!,
              merge(props, {
                get children() {
                  return inner;
                },
              }),
            ),
          )}
        </Errored>
      </Show>
    );
  }
  function shown() {
    // The element belongs to the hide/replace branches. Wrapping moves its
    // rendered nodes into another parent without disposing their Solid owner.
    const element = (
      <Show keyed when={replacement()} fallback={render(contents)}>
        {(item) => (
          <Errored fallback={() => render(contents)}>
            {untrack(() => createComponent(item.action.layer!, props))}
          </Errored>
        )}
      </Show>
    );
    // Installing or reloading a plugin that adds a wrapper remounts this element's wrappers by design.
    const wrapped = createMemo(() =>
      wrappers().reduceRight((inner, wrapper) => surround(wrapper, inner), element),
    );
    return (
      <>
        {additions("before")}
        {wrapped()}
        {additions("after")}
      </>
    );
  }
  return <Show when={!hidden()}>{shown()}</Show>;
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicAttributes {
      // Existing components can still use these names for their own props.
      // The plugin compiler validates markers inside component() renders.
      part?: unknown;
      locked?: unknown;
    }
    // @ts-ignore The plugin compiler consumes placement callbacks before Solid handles the children.
    interface ElementAttributes<T> {
      locked?: true;
      children?: CustomAttributes<T>["children"] | ((added: PartAdditions) => Element);
    }
  }
}
