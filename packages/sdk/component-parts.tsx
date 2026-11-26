import {
  createComponent,
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  onSettled,
  runWithOwner,
  Errored,
  For,
  merge,
  Show,
  untrack,
  useContext,
} from "solid-js";
import { insert, type JSX } from "@solidjs/web";
import {
  componentActionKind,
  type ComponentAction,
  type ComponentActionKind,
  type OriginalElement,
} from "./component-actions";

export interface LoadedPartAction {
  id: string;
  fingerprint?: string;
  plugin: string;
  order: number;
  installOrder?: number;
  action: ComponentAction;
  /** Reads the action's `when` with the props of the component that owns the element. */
  enabled(props: object): boolean;
}
type ChildOverride = () => JSX.Element;
type LayerContents = {
  draw: ChildOverride;
  fail(cause: unknown): void;
};
type ReadOverride = () => LayerContents | undefined;

function drawContents(contents: LayerContents): JSX.Element {
  return (
    <Errored
      fallback={(cause) => {
        contents.fail(cause());
        return undefined;
      }}
    >
      {contents.draw()}
    </Errored>
  );
}
type Contents = {
  native?: { read: ReadOverride; capture(children: ChildOverride): void };
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
  warn(key: readonly string[], message: string): void;
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
  authored?: number,
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

const plainHole: RenderHole = (_id, render) => render;
const plainSpread = (props: object) => props;

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

function nativeContents(
  element: Element,
  contents: Contents,
  authored?: ChildOverride,
  resume?: () => void,
  suspend?: () => void,
) {
  const { prepend, append, native } = contents;
  function additions() {
    if (prepend) insert(element, prepend(), nativeRange(element, element.firstChild));
    if (append) insert(element, append(), nativeRange(element, null));
  }
  if (!native) return additions();
  if (
    element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
    /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(element.localName)
  )
    return;

  // Keep the template untouched in the pass-through branch. When its
  // children are overridden, retire native observers and holes before
  // parking the template's children so no live insert still owns them.
  const changed = createMemo(() => !!native.read());
  createEffect(
    () => {
      const owner = getOwner();
      if (!changed()) {
        resume?.();
        onSettled(() => {
          runWithOwner(owner, additions);
        });
        return;
      }
      suspend?.();
      let restore: (() => void) | undefined;
      onCleanup(() => restore?.());
      onSettled(() => {
        const children = Array.from(element.childNodes);
        native.capture(authored ?? (() => children));
        element.replaceChildren();
        restore = () => {
          element.replaceChildren(...children);
          native.capture(() => undefined);
        };
        runWithOwner(owner, () =>
          insert(element, () => {
            const override = native.read();
            return override && drawContents(override);
          }),
        );
      });
    },
    () => {},
  );
}

export function renderNativePart(
  target: string,
  fingerprint: string | null | undefined,
  props: object,
  row: (() => object) | undefined,
  create: (refs: Element[], hole: RenderHole, authored?: number) => JSX.Element,
  children: readonly NativeSite[],
  original?: number,
) {
  const registry = useContext(PartActions);
  if (!registry) return create([], plainHole);
  if (!children.length)
    return renderPart(target, fingerprint, props, row, (contents) => {
      const element = create([], plainHole) as Element;
      nativeContents(
        element,
        contents,
        contents.native && original ? () => create([], plainHole, original) : undefined,
      );
      return element;
    });

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
    const scope = { registry, refs, owner: getOwner(), props, row, setHoles, create };
    let bindings = registerNative(element, children, scope);
    onCleanup(() => stopNative(bindings));
    if (contents.native) {
      nativeContents(
        element,
        contents,
        original ? () => create([], plainHole, original) : undefined,
        () => {
          if (bindings.length) return;
          for (const state of active) state?.[1](true);
          bindings = registerNative(element, children, scope);
        },
        () => {
          stopNative(bindings);
          bindings = [];
          for (const state of active) state?.[1](false);
        },
      );
    } else nativeContents(element, contents);
    return element;
  });
}

type NativeScope = {
  registry: PartRegistry;
  refs: Element[];
  owner: ReturnType<typeof getOwner>;
  props: object;
  row: (() => object) | undefined;
  create(refs: Element[], hole: RenderHole, authored?: number): JSX.Element;
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
    const [target, fingerprint, children, , hole, authored] = this.site;
    const actions = installed.filter((item) => matches(registry, target, fingerprint, item));
    if (!actions.length) {
      if (typeof hole === "number" || children.length) setHoles(hole, children, true);
      this.registerChildren();
      return;
    }
    const destructive = actions.some(({ action }) => {
      const kind = componentActionKind(action);
      return kind === "hide" || kind === "layer";
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
        const decorated = renderActions(registry, actions, placementProps, (contents) => {
          const activate = () => {
            if (destructive) setHoles(hole, children, true);
            this.registerChildren();
          };
          if (destructive) onCleanup(deactivate);
          if (contents.native) {
            nativeContents(
              element,
              contents,
              authored ? () => this.scope.create([], plainHole, authored) : undefined,
              activate,
              deactivate,
            );
          } else {
            activate();
            nativeContents(element, contents);
          }
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
  plain.spread = plainSpread;
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
      if (!installed.length) return (decorated = renderOriginal());
      const actions = installed.filter((item) => matches(registry!, target, fingerprint, item));
      if (!actions.length) return (decorated = renderOriginal());
      const outside = actions.every(({ action }) => {
        const kind = componentActionKind(action);
        return kind === "before" || kind === "after";
      });
      if (!outside) {
        disposeOriginal?.();
        disposeOriginal = undefined;
      }
      const placementProps = row ? merge(props, { $row: row() }) : props;
      return (decorated = runWithOwner(owner, () =>
        createRoot((dispose) => {
          disposeActions = dispose;
          return renderActions(
            registry!,
            actions,
            placementProps,
            outside ? renderOriginal : render,
            original,
          );
        }),
      ));
    });
  };
}

function renderActions(
  registry: PartRegistry,
  actions: readonly LoadedPartAction[],
  props: object,
  render: (contents: Contents) => JSX.Element,
  original?: () => JSX.Element,
): JSX.Element {
  const at = (kind: ComponentActionKind) =>
    actions.filter((item) => componentActionKind(item.action) === kind);
  const enabled = (item: LoadedPartAction) => item.enabled(props);
  const hides = at("hide");
  const layers = at("layer").sort(
    (a, b) =>
      (a.installOrder ?? Infinity) - (b.installOrder ?? Infinity) ||
      a.order - b.order ||
      a.plugin.localeCompare(b.plugin) ||
      a.id.localeCompare(b.id),
  );

  function additions(items: LoadedPartAction[]) {
    return (
      <For each={items}>
        {(item) => (
          <Show when={enabled(item)}>
            <Errored fallback={() => null}>
              {untrack(() => createComponent((item.action as ComponentAction<"before">).layer!, props))}
            </Errored>
          </Show>
        )}
      </For>
    );
  }

  const leading = at("prepend");
  const trailing = at("append");
  const hasInside = leading.length > 0 || trailing.length > 0;
  const ForwardedChildren = layers.length ? createContext<ChildOverride | null>(null) : undefined;
  let nativeChildren: ChildOverride | undefined;
  function authored(children = original ?? nativeChildren) {
    if (!hasInside) return children?.();
    return (
      <>
        {additions(leading)}
        {children?.()}
        {additions(trailing)}
      </>
    );
  }

  function renderElement(read?: ReadOverride) {
    const contents: Contents = (children) => {
      if (!read) return authored(children);
      const current = createMemo(() => {
        const override = read();
        if (!override) return authored(children);
        if (!children || !ForwardedChildren) return drawContents(override);
        return (
          <ForwardedChildren value={() => authored(children)}>{drawContents(override)}</ForwardedChildren>
        );
      });
      return <>{current()}</>;
    };
    if (read)
      contents.native = {
        read,
        capture: (children) => {
          nativeChildren = children;
        },
      };
    if (leading.length) contents.prepend = () => additions(leading);
    if (trailing.length) contents.append = () => additions(trailing);
    contents.spread = (forwarded: { readonly children?: JSX.Element }) =>
      hasInside || read
        ? merge(forwarded, {
            get children() {
              return contents(() => forwarded.children);
            },
          })
        : forwarded;
    return render(contents);
  }

  function shown() {
    return (
      <>
        {additions(at("before"))}
        {layers.length
          ? renderLayers(registry, layers, props, renderElement, () =>
              (useContext(ForwardedChildren!) ?? authored)(),
            )
          : renderElement()}
        {additions(at("after"))}
      </>
    );
  }
  return <Show when={!hides.some(enabled)}>{shown()}</Show>;
}

const noOverride: ReadOverride = () => undefined;

function renderLayers(
  registry: PartRegistry,
  layers: LoadedPartAction[],
  props: object,
  render: (read: ReadOverride) => JSX.Element,
  authored: () => JSX.Element,
) {
  const owner = getOwner();
  const pending = new Set<() => void>();
  const [revision, revise] = createSignal(0, { ownedWrite: true });
  let closed = false;
  createEffect(revision, () => {
    for (const release of pending) {
      pending.delete(release);
      release();
    }
  });
  const disposers: (() => void)[] = [];
  onCleanup(() => {
    closed = true;
    for (const dispose of disposers) dispose();
  });

  // A stage's owner lives outside the layer that requests it. Switching
  // between a wrapper and its fallback moves the stage without remounting it.
  function stage(draw: (read: ReadOverride) => JSX.Element) {
    let users = 0;
    let dispose: (() => void) | undefined;
    let output: JSX.Element;
    let setInput: (read: ReadOverride) => void;
    function release() {
      if (users || !dispose) return;
      dispose();
      dispose = undefined;
      output = undefined;
    }
    disposers.push(() => dispose?.());
    return (input: ReadOverride): JSX.Element => {
      users++;
      onCleanup(() => {
        if (--users || closed) return;
        pending.add(release);
        revise((n) => n + 1);
      });
      if (dispose) setInput(input);
      else {
        output = runWithOwner(owner, () =>
          createRoot((cleanup) => {
            dispose = cleanup;
            const [readInput, writeInput] = createSignal({ input }, { ownedWrite: true });
            setInput = (next) =>
              writeInput((current) => (current.input === next ? current : { input: next }));
            const override = createMemo(() => readInput().input());
            return draw(override);
          }),
        );
      }
      return output;
    };
  }

  const top = layers.reduceRight(
    (next, item) => stage((read) => renderLayer(registry, item, props, authored, next, read)),
    stage(render),
  );
  return top(noOverride);
}

function renderLayer(
  registry: PartRegistry,
  item: LoadedPartAction,
  props: object,
  authored: ChildOverride,
  next: (read: ReadOverride) => JSX.Element,
  read: ReadOverride,
) {
  const target = item.action.target;
  const draw = (item.action as ComponentAction<"layer">).layer!;
  function warn(cause: unknown) {
    registry.warn(
      ["error", item.plugin, item.id],
      `Component layer ${item.plugin}/${item.id} failed: ${String(cause)}`,
    );
  }

  function activeLayer() {
    let claimed = false;
    const [failed, setFailed] = createSignal(false, { ownedWrite: true });
    const owner = getOwner();
    const Original: OriginalElement = Object.assign(
      (passed: { readonly children?: JSX.Element }) => {
        if (claimed) {
          registry.warn(
            ["duplicate", item.plugin, target],
            `Component layer ${item.plugin}/${item.id} drew Original twice for ${target}`,
          );
          return undefined;
        }
        claimed = true;
        onCleanup(() => {
          claimed = false;
        });
        if (!("children" in passed)) return next(read);
        const children: LayerContents = {
          draw: () => passed.children,
          fail(cause) {
            // Children render at the bottom of the stack. Report their
            // failure back to the layer that supplied them.
            warn(cause);
            runWithOwner(owner, () =>
              onSettled(() => {
                setFailed(true);
              }),
            );
          },
        };
        return next(() => children);
      },
      { Children: () => authored() },
    );
    return (
      <Show when={!failed()} fallback={next(read)}>
        <Errored
          fallback={(cause) => {
            warn(cause());
            return next(read);
          }}
        >
          {draw(props, Original)}
        </Errored>
      </Show>
    );
  }
  return (
    <Show when={item.enabled(props)} fallback={next(read)}>
      {activeLayer()}
    </Show>
  );
}
