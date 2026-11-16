/** Fixed shell regions; views teleport content into the frame.
 *
 * <Shell>
 *   <Shell.Sidebar>Threads</Shell.Sidebar>
 *   <Shell.Stage>Messages</Shell.Stage>
 *   <Shell.BottomBar><Composer docked /></Shell.BottomBar>
 * </Shell>
 *
 * Teleports resolve under their view's owner, so context and cleanup follow
 * the view. Events and inherited CSS follow their destination region.
 */
import { For, children, createContext, createSignal, onCleanup, useContext } from "solid-js";
import type { Accessor } from "solid-js";
import type { JSX } from "@tokamak/render";
import { dismissOutside } from "./dismiss";

type Region = "top-start" | "top-center" | "top-end" | "stage-top" | "rail" | "sidebar" | "stage" | "bottom";

interface Entry {
  content: Accessor<JSX.Element>;
}

interface Regions {
  add(region: Region, entry: Entry): () => void;
  list(region: Region): Accessor<Entry[]>;
}

const ShellContext = createContext<Regions>();

function createRegions(): Regions {
  const signals = new Map<Region, ReturnType<typeof createSignal<Entry[]>>>();
  const signal = (region: Region) => {
    let s = signals.get(region);
    if (!s) signals.set(region, (s = createSignal<Entry[]>([])));
    return s;
  };
  return {
    add(region, entry) {
      const [list, setList] = signal(region);
      setList([...list(), entry]);
      return () => setList(signal(region)[0]().filter((e) => e !== entry));
    },
    list: (region) => signal(region)[0],
  };
}

function Slot(props: { region: Region }) {
  const regions = useContext(ShellContext)!;
  return <For each={regions.list(props.region)()}>{(entry) => <>{entry.content()}</>}</For>;
}

function teleport(region: Region) {
  return (props: { children?: JSX.Element }) => {
    const regions = useContext(ShellContext);
    if (!regions) throw new Error("Shell regions must be used inside <Shell>");
    // Resolved here, under the view's owner.
    const content = children(() => props.children);
    const entry: Entry = { content };
    onCleanup(regions.add(region, entry));
    return null;
  };
}

const topBarRegions = {
  start: teleport("top-start"),
  center: teleport("top-center"),
  end: teleport("top-end"),
  stage: teleport("stage-top"),
};

function TopBar(props: { at?: keyof typeof topBarRegions; children?: JSX.Element }) {
  // `at` is fixed for the life of the component (a region, not a style).
  const Region = topBarRegions[props.at ?? "center"];
  return <Region>{props.children}</Region>;
}

/** Shared rail geometry, CSS px. */
export const rail = {
  width: 56,
  item: 38,
  gap: 8,
  inset: 13,
} as const;

/** Shared with the native traffic-light placement, CSS px. */
export const topBar = {
  height: 40,
  left: 13,
  reserve: 13 + 2 * 20 + 14 + 11,
} as const;

export interface ShellProps {
  /** Keep room for the macOS traffic-light buttons (custom title bar). */
  trafficLights?: boolean;
  children?: JSX.Element;
}

function ShellFrame(props: ShellProps) {
  const regions = createRegions();
  return (
    <ShellContext.Provider value={regions}>
      {/* Every click in the window bubbles up to here: open menus that it
       * missed close (dismiss.ts). */}
      <div
        class="flex h-screen w-screen flex-col overflow-hidden bg-base font-ui text-ink"
        onClick={dismissOutside}
      >
        <div
          window-drag
          class={`relative isolate flex shrink-0 items-center pr-2 ${
            props.trafficLights === false ? "pl-3.5" : "pl-(--tk-window-buttons) [[data-fullscreen]_&]:pl-3.5"
          }`}
          style={`height: ${topBar.height}px; --tk-window-buttons: ${topBar.reserve}px`}
        >
          {/* Start and end keep their design widths on wide windows and give
           * way (down to their content) on narrow ones; the centre keeps at
           * least 220 px, so the three never overlap. */}
          <div class="flex w-[342px] items-center gap-1.5">
            <Slot region="top-start" />
          </div>
          <div class="flex min-w-[220px] flex-1 justify-center">
            <Slot region="top-center" />
          </div>
          <div class="flex w-[420px] items-center justify-end gap-0.5">
            <Slot region="top-end" />
          </div>
        </div>
        <div class="flex min-h-0 flex-1 gap-2 pr-2 pb-2">
          <div id="shell-sidebar" class="relative flex shrink-0 rounded-[12px] bg-sidebar">
            <div
              class="relative isolate flex shrink-0 flex-col items-start"
              style={`width: ${rail.width}px; gap: ${rail.gap}px; padding-left: ${rail.inset}px`}
            >
              <Slot region="rail" />
            </div>
            <div class="flex">
              <div class="relative isolate flex w-[220px] shrink-0 flex-col gap-0.5 px-1.5 py-2">
                <Slot region="sidebar" />
              </div>
            </div>
          </div>
          <div id="shell-stage-surface" class="relative isolate min-w-0 flex-1 rounded-[12px] bg-panel">
            {/* Keep z-indexed descendants inside the stage. */}
            <div id="shell-stage" class="absolute inset-x-0 inset-y-0 z-0 overflow-y-auto rounded-[12px]">
              <Slot region="stage" />
            </div>
            <div class="pointer-events-none absolute inset-x-0 top-0 isolate flex flex-col items-center *:pointer-events-auto">
              <Slot region="stage-top" />
            </div>
            {/* The bottom bar never takes more than 60% of the stage. Its
             * content gets that as a definite limit (a flex column), so a
             * child with `min-h-0` can give up room (the composer's text). */}
            <div class="pointer-events-none absolute inset-x-0 bottom-0 isolate flex max-h-[60%] flex-col items-center *:pointer-events-auto">
              <Slot region="bottom" />
            </div>
          </div>
        </div>
      </div>
      {/* Views: their teleports render into the regions above, not here. */}
      {props.children}
    </ShellContext.Provider>
  );
}

/** The shell frame and its teleport regions. */
export const Shell = Object.assign(ShellFrame, {
  TopBar,
  Rail: teleport("rail"),
  Sidebar: teleport("sidebar"),
  Stage: teleport("stage"),
  BottomBar: teleport("bottom"),
});
