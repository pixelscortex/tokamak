import {
  createComponent,
  createContext,
  createMemo,
  createRoot,
  getOwner,
  onCleanup,
  runWithOwner,
  Errored,
  For,
  merge,
  Show,
  untrack,
  useContext,
} from "solid-js";
import { insert, type JSX } from "@solidjs/web";
import { componentActionKind, type ComponentAction, type ComponentActionKind } from "./component-actions";

export interface LoadedPartAction {
  id: string;
  fingerprint?: string;
  plugin: string;
  order: number;
  action: ComponentAction;
  /** Reads the action's `when` with the props of the component that owns the element. */
  enabled(props: object): boolean;
}
type Contents = {
  (override?: () => JSX.Element): JSX.Element;
  prepend?: () => JSX.Element;
  append?: () => JSX.Element;
  spread(props: { readonly children?: JSX.Element }): object;
};

export interface PartRegistry {
  read(target: string): () => readonly LoadedPartAction[];
  observe(target: string, notify: (actions: readonly LoadedPartAction[]) => void): () => void;
}

export const PartActions = createContext<PartRegistry | null>(null);

type NativeSite = readonly [target: string, fingerprint: string, children: readonly NativeSite[]];

// Native templates own their DOM nodes. Additions get their own insertion
// ranges, so changing one path leaves the other nodes and observers alone.
function nativeRange(parent: Element, before: Node | null, original?: Element) {
  const start = parent.ownerDocument.createTextNode("");
  const end = parent.ownerDocument.createTextNode("");
  parent.insertBefore(start, original ?? before);
  parent.insertBefore(end, before);
  onCleanup(() => {
    if (original) parent.insertBefore(original, end);
    while (start.nextSibling && start.nextSibling !== end && start.nextSibling !== original)
      parent.removeChild(start.nextSibling);
    start.remove();
    end.remove();
  });
  return end;
}

function nativeContents(element: Element, { prepend, append }: Contents) {
  if (prepend) insert(element, prepend(), nativeRange(element, element.firstChild));
  if (append) insert(element, append(), nativeRange(element, null));
}

export function renderNativePart(
  target: string,
  fingerprint: string,
  props: object,
  row: (() => object) | undefined,
  create: () => JSX.Element,
  children: readonly NativeSite[],
) {
  const registry = useContext(PartActions);
  if (!registry) return create();

  function register(node: Element, sites: readonly NativeSite[], owner: ReturnType<typeof getOwner>) {
    let child = node.firstElementChild;
    const cleanups: (() => void)[] = [];
    for (const [target, fingerprint, children] of sites) {
      if (!child) break;
      const element = child;
      child = element.nextElementSibling;
      let dispose: (() => void) | undefined;
      let inner: (() => void) | undefined;
      const stop = registry!.observe(target, (installed) => {
        dispose?.();
        dispose = undefined;
        const actions = installed.filter((item) => !item.fingerprint || item.fingerprint === fingerprint);
        if (!actions.length) {
          if (children.length) inner ??= register(element, children, owner);
          return;
        }
        const destructive = actions.some(({ action }) => {
          const kind = componentActionKind(action);
          return kind === "hide" || kind === "replace";
        });
        if (destructive) {
          inner?.();
          inner = undefined;
        }
        const parent = element.parentElement!;
        const next = element.nextSibling;
        const placementProps = row ? merge(props, { $row: row() }) : props;
        runWithOwner(owner, () =>
          createRoot((cleanup) => {
            dispose = cleanup;
            const end = nativeRange(parent, next, element);
            const decorated = renderActions(actions, placementProps, (contents) => {
              if (children.length) inner ??= register(element, children, owner);
              if (destructive)
                onCleanup(() => {
                  inner?.();
                  inner = undefined;
                });
              nativeContents(element, contents);
              return element;
            });
            insert(parent, decorated, end, [element]);
          }),
        );
      });
      if (!dispose && children.length) inner ??= register(element, children, owner);
      cleanups.push(() => {
        stop();
        dispose?.();
        inner?.();
      });
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }

  return renderPart(target, fingerprint, props, row, (contents) => {
    const element = create() as Element;
    const owner = getOwner();
    if (children.length) onCleanup(register(element, children, owner));
    nativeContents(element, contents);
    return element;
  });
}

/** Compiler entry point. Keep the original element and contents lazy so hiding
 * or replacing the element disposes its entire Solid owner. */
export function renderPart(
  target: string,
  fingerprint: string,
  props: object,
  row: (() => object) | undefined,
  render: (contents: Contents) => JSX.Element,
  original?: () => JSX.Element,
): JSX.Element | (() => JSX.Element) {
  const read = useContext(PartActions)?.read(target);
  const plain = (override = original) => override?.();
  plain.spread = (props: object) => props;
  if (!read) return render(plain);

  // The insert can move between wrapper owners. Keep the original in a
  // separate owner so a sibling placement never remounts the element.
  const owner = getOwner();
  let disposeOriginal: (() => void) | undefined;
  let disposeActions: (() => void) | undefined;
  let element: JSX.Element;
  let decorated: JSX.Element;
  let previous: readonly LoadedPartAction[] | undefined;
  onCleanup(() => {
    disposeActions?.();
    disposeOriginal?.();
  });

  function renderOriginal() {
    if (!disposeOriginal) {
      element = runWithOwner(owner, () =>
        createRoot((dispose) => {
          disposeOriginal = dispose;
          return render(plain);
        }),
      );
    }
    return element;
  }

  return () => {
    const installed = read();
    if (installed === previous) return decorated;
    previous = installed;
    return untrack(() => {
      disposeActions?.();
      disposeActions = undefined;
      const actions = installed.filter((item) => !item.fingerprint || item.fingerprint === fingerprint);
      if (!actions.length) return (decorated = renderOriginal());
      const outside = actions.every(({ action }) => {
        const kind = componentActionKind(action);
        return kind === "before" || kind === "after" || kind === "wrap";
      });
      if (!outside) {
        disposeOriginal?.();
        disposeOriginal = undefined;
      }
      const placementProps = row ? merge(props, { $row: row() }) : props;
      return (decorated = runWithOwner(owner, () =>
        createRoot((dispose) => {
          disposeActions = dispose;
          return renderActions(actions, placementProps, outside ? renderOriginal : render, original);
        }),
      ));
    });
  };
}

function renderActions(
  actions: readonly LoadedPartAction[],
  props: object,
  render: (contents: Contents) => JSX.Element,
  original?: () => JSX.Element,
): JSX.Element {
  const at = (kind: ComponentActionKind) =>
    actions.filter((item) => componentActionKind(item.action) === kind);
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
  const hasInside = () => at("prepend").length > 0 || at("append").length > 0;
  function contents(override = original) {
    if (!override && !hasInside()) return undefined;
    return (
      <>
        {additions("prepend")}
        {override?.()}
        {additions("append")}
      </>
    );
  }
  if (at("prepend").length) contents.prepend = () => additions("prepend");
  if (at("append").length) contents.append = () => additions("append");
  contents.spread = (forwarded: { readonly children?: JSX.Element }) =>
    hasInside()
      ? merge(forwarded, {
          get children() {
            return contents(() => forwarded?.children);
          },
        })
      : forwarded;

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
