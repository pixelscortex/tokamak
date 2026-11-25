import {
  createComponent,
  createContext,
  createMemo,
  createRoot,
  createSignal,
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

export interface PartObserver {
  update(actions: readonly LoadedPartAction[]): void;
}

export interface PartRegistry {
  mismatch(plugin: string, target: string): void;
  read(target: string): () => readonly LoadedPartAction[];
  observe(target: string, observer: PartObserver): void;
  unobserve(target: string, observer: PartObserver): void;
}

export const PartActions = createContext<PartRegistry | null>(null);

type NativeSite = readonly [
  target: string,
  fingerprint: string | null | undefined,
  children: readonly NativeSite[],
  ref?: number | null,
  hole?: number | null,
];
type RenderHole = (
  id: number,
  render: () => JSX.Element | (() => JSX.Element),
) => () => JSX.Element | (() => JSX.Element);

function matches(
  registry: PartRegistry,
  target: string,
  fingerprint: string | null | undefined,
  item: LoadedPartAction,
) {
  if (!item.fingerprint || !fingerprint || item.fingerprint === fingerprint) return true;
  registry.mismatch(item.plugin, target);
  return false;
}

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
  fingerprint: string | null | undefined,
  props: object,
  row: (() => object) | undefined,
  create: (refs: Element[], hole: RenderHole) => JSX.Element,
  children: readonly NativeSite[],
) {
  const registry = useContext(PartActions);
  if (!registry) return create([], (_id, render) => render);

  return renderPart(target, fingerprint, props, row, (contents) => {
    const refs: Element[] = [];
    const active: ReturnType<typeof createSignal<boolean>>[] = [];

    const hole: RenderHole = (id, render) => {
      let state = active[id];
      if (!state) active[id] = state = createSignal(true, { ownedWrite: true });
      const [shown] = state;
      return createMemo(() => (shown() ? untrack(render) : undefined));
    };

    function setHoles(id: number | null | undefined, sites: readonly NativeSite[], enabled: boolean) {
      if (typeof id === "number") {
        const state = active[id];
        if (!state) active[id] = createSignal(enabled, { ownedWrite: true });
        else state[1](enabled);
      }
      for (const [, , descendants, , hole] of sites) setHoles(hole, descendants, enabled);
    }

    const element = create(refs, hole) as Element;
    if (children.length) {
      const bindings = registerNative(element, children, {
        registry,
        refs,
        owner: getOwner(),
        props,
        row,
        setHoles,
      });
      onCleanup(() => stopNative(bindings));
    }
    nativeContents(element, contents);
    return element;
  });
}

type NativeScope = {
  registry: PartRegistry;
  refs: Element[];
  owner: ReturnType<typeof getOwner>;
  props: object;
  row: (() => object) | undefined;
  setHoles(id: number | null | undefined, sites: readonly NativeSite[], enabled: boolean): void;
};

function registerNative(node: Element, sites: readonly NativeSite[], scope: NativeScope) {
  let child = node.firstElementChild;
  const bindings: NativeBinding[] = [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]!;
    const ref = site[3];
    const element = typeof ref === "number" ? scope.refs[ref] : child;
    if (!element || (typeof ref === "number" && element.parentElement !== node)) continue;
    if (i + 1 < sites.length && typeof sites[i + 1]![3] !== "number") child = element.nextElementSibling;
    const binding = new NativeBinding(scope, element, site);
    bindings.push(binding);
    binding.start();
  }
  return bindings;
}

function stopNative(bindings: NativeBinding[] | undefined) {
  if (bindings) for (const binding of bindings) binding.stop();
}

class NativeBinding implements PartObserver {
  private dispose?: () => void;
  private inner?: NativeBinding[];

  constructor(
    private scope: NativeScope,
    private element: Element,
    private site: NativeSite,
  ) {}

  start() {
    this.scope.registry.observe(this.site[0], this);
    if (!this.dispose) this.registerChildren();
  }

  stop() {
    this.scope.registry.unobserve(this.site[0], this);
    this.dispose?.();
    stopNative(this.inner);
  }

  private registerChildren() {
    if (this.site[2].length) this.inner ??= registerNative(this.element, this.site[2], this.scope);
  }

  update(installed: readonly LoadedPartAction[]) {
    this.dispose?.();
    this.dispose = undefined;
    const { registry, owner, props, row, setHoles } = this.scope;
    const [target, fingerprint, children, , hole] = this.site;
    const actions = installed.filter((item) => matches(registry, target, fingerprint, item));
    if (!actions.length) {
      if (typeof hole === "number" || children.length) setHoles(hole, children, true);
      this.registerChildren();
      return;
    }
    const destructive = actions.some(({ action }) => {
      const kind = componentActionKind(action);
      return kind === "hide" || kind === "replace";
    });
    const deactivate = () => {
      setHoles(hole, children, false);
      stopNative(this.inner);
      this.inner = undefined;
    };
    if (destructive) deactivate();

    const element = this.element;
    const parent = element.parentElement!;
    const next = element.nextSibling;
    const placementProps = row ? merge(props, { $row: row() }) : props;
    runWithOwner(owner, () =>
      createRoot((cleanup) => {
        this.dispose = cleanup;
        const end = nativeRange(parent, next, element);
        const decorated = renderActions(actions, placementProps, (contents) => {
          this.registerChildren();
          if (destructive) {
            setHoles(hole, children, true);
            onCleanup(deactivate);
          }
          nativeContents(element, contents);
          return element;
        });
        insert(parent, decorated, end, [element]);
      }),
    );
  }
}

/** Compiler entry point. Keep the original element and contents lazy so hiding
 * or replacing the element disposes its entire Solid owner. */
export function renderPart(
  target: string,
  fingerprint: string | null | undefined,
  props: object,
  row: (() => object) | undefined,
  render: (contents: Contents) => JSX.Element,
  original?: () => JSX.Element,
): JSX.Element | (() => JSX.Element) {
  const registry = useContext(PartActions);
  const read = registry?.read(target);
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
      const actions = installed.filter((item) => matches(registry!, target, fingerprint, item));
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
