import { createContext, createSignal, onCleanup, Show, useContext, type Accessor } from "solid-js";
import { Portal, type JSX } from "@solidjs/web";

export type RegionName = "sidebar" | "header" | "panel";
type Children = { children?: JSX.Element };
function createRegionState() {
  const [outlet, setOutlet] = createSignal<HTMLDivElement>();
  const [count, setCount] = createSignal(0, { ownedWrite: true });
  return { outlet, setOutlet, count, setCount };
}
function createRegions() {
  const [titles, setTitles] = createSignal<readonly Accessor<string | undefined>[]>([], { ownedWrite: true });
  return {
    sidebar: createRegionState(),
    header: createRegionState(),
    panel: createRegionState(),
    titles,
    setTitles,
  };
}
const Regions = createContext<ReturnType<typeof createRegions> | null>(null);

export function RegionProvider(props: Children) {
  const regions = createRegions();
  return <Regions value={regions}>{props.children}</Regions>;
}

export function RegionOutlet(props: { name: RegionName; class?: string }) {
  const regions = useContext(Regions);
  const region = regions?.[props.name];
  let element!: HTMLDivElement;
  onCleanup(() => {
    if (region?.outlet() === element) region.setOutlet(undefined);
  });
  return (
    <div
      ref={(node) => {
        element = node;
        region?.setOutlet(node);
      }}
      // oxlint-disable-next-line shadcn/no-inline-styles -- Outlets must not introduce a layout box.
      style={{ display: "contents" }}
      data-region={props.name}
      class={props.class}
    />
  );
}

export function useRegionFilled(name: RegionName): () => boolean {
  const region = useContext(Regions)?.[name];
  return () => (region?.count() ?? 0) > 0;
}

function regionComponent(name: RegionName) {
  return (props: Children) => {
    const region = useContext(Regions)?.[name];
    if (!region) return null;
    region.setCount((count) => count + 1);
    onCleanup(() => region.setCount((count) => count - 1));
    return (
      <Show when={region.outlet()}>{(outlet) => <Portal mount={outlet()}>{props.children}</Portal>}</Show>
    );
  };
}

export const Region = {
  Sidebar: regionComponent("sidebar"),
  Header: regionComponent("header"),
  Panel: regionComponent("panel"),
};

/**
 * Names the page while the calling view is mounted: the shell shows it in the
 * tab and the window title. Undefined falls back to the view's title.
 */
export function usePageTitle(title: Accessor<string | undefined>): void {
  const regions = useContext(Regions);
  if (!regions) return;
  regions.setTitles((list) => [...list, title]);
  onCleanup(() => regions.setTitles((list) => list.filter((item) => item !== title)));
}

/** The title the most recently mounted view gave its page, for the shell. */
export function usePageTitleValue(): Accessor<string | undefined> {
  const regions = useContext(Regions);
  return () => {
    const list = regions?.titles() ?? [];
    for (let index = list.length - 1; index >= 0; index--) {
      const value = list[index]!()?.trim();
      if (value) return value;
    }
    return undefined;
  };
}
