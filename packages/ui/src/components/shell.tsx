/** The application shell as fixed presentational regions.
 *
 *   <Shell>
 *     <ChatView />                       // anywhere below Shell
 *   </Shell>
 *
 *   function ChatView() {
 *     return <>
 *       <Shell.TopBar at="end"><NewChatButton /></Shell.TopBar>
 *       <Shell.Sidebar><ThreadList /></Shell.Sidebar>
 *       <Shell.Stage><Messages /></Shell.Stage>
 *       <Shell.BottomBar><Composer /></Shell.BottomBar>
 *     </>;
 *   }
 *
 * Regions: the top bar (`TopBar` with `at` = start | center | end, plus
 * `at="stage"` for content that hangs from the top bar over the stage, such as
 * a view title), the `Rail`, the plugin `Sidebar`, the `Stage` (the only part
 * that scrolls; the window never does) and the `BottomBar` (pinned to the
 * bottom of the stage, e.g. a composer rising from the window base). Views
 * never create, size or position regions: they teleport content into them.
 *
 * Teleport: `solid-js/universal` has no Portal, so each region keeps a list
 * of entries. A teleport component resolves its children where it is written
 * (under the view's owner, so context and cleanup follow the view), registers
 * them with the frame, and renders nothing in place; the frame renders every
 * entry of a region in order. Limits: events bubble through the region's
 * ancestors, not the view's; CSS context (inherited styles, containing
 * blocks) is the region's; several entries in one region stack in mount order.
 *
 * Layers: the window base, the plugin container (`sidebar` material, behind
 * the sidebar) and the stage panel (`panel` material) are
 * surfaces with fixed group names, so a shape anywhere can join them:
 * `<Surface.Union layer="base">`, `layer="sidebar"`, `layer="stage"`.
 *
 * Plates: every region here is a plate region (render/SURFACES.md,
 * "Plates"), so an element with a solid background (`bg-*`) or a
 * `material-*` class anywhere in a view is a plate without a component. By
 * default each plate paints itself, as part of its own element. With
 * `<Shell plates="sheet">` every shell region's layer draws its plates
 * instead, below the region's content; the stage's layer then stays fixed
 * over the stage while its content scrolls (plates are drawn where they are
 * on screen and clipped at the stage edge). Views never write a layer; a
 * part of a view that wants the other painter, and floating pieces outside
 * the regions, use `Sheet`.
 *
 * Window chrome: with render's `WindowOptions::custom_titlebar` the top bar is
 * the title bar. Its empty parts drag the window (`window-drag`), and it keeps
 * room for the traffic-light buttons except in full screen (`data-fullscreen`
 * on the root element, set by the render host).
 */
import { For, children, createContext, createSignal, onCleanup, useContext } from "solid-js";
import type { Accessor } from "solid-js";
import type { JSX } from "@tokamak/render";
import { MaterialsLayer, Surface, shellGroups } from "./surface";
import type { PlatePainter } from "./surface";

type Region =
  | "top-start"
  | "top-center"
  | "top-end"
  | "stage-top"
  | "rail"
  | "sidebar"
  | "stage"
  | "bottom";

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

/** Rail geometry, CSS px, in one place (the shell lays the column out; a
 * view's rail items, and a tab fused into the container if a view draws
 * one, use the same numbers).
 * - `width`: the rail column, window edge to the plugin container.
 * - `item`: each item's square hit area; icons stay ~20 px, the rest is air.
 * - `gap`: between items.
 * - `inset`: from the window edge to the items.
 * - `tab`: from the window edge to a fused tab for the active item, which
 *   would run to the container, the icon centred in it: equal room on the
 *   free side and on the side fused into the container. The lab draws
 *   none. */
export const rail = {
  width: 56,
  item: 38,
  gap: 8,
  inset: 13,
  tab: 8,
} as const;

/** Top bar and macOS window buttons (custom title bar), CSS px. The native
 * host places the buttons from the same numbers (render `WindowOptions::
 * traffic_lights`: `left` and `height / 2`; the lab's main.rs passes them
 * and its tests check they agree with these).
 * - `height`: the top bar, which is the title bar.
 * - `left`: window edge to the close button (the design file's position).
 * - `reserve`: the top bar's start padding while the buttons are shown:
 *   close, minimise and zoom (14 px each, 20 px apart) plus 11 px of air. */
export const topBar = {
  height: 40,
  left: 13,
  reserve: 13 + 2 * 20 + 14 + 11,
} as const;

/** Top of rail item `i` within the rail column (the first is level with the
 * plugin container's top, so a fused tab's top edge would run straight into
 * the container's). */
export const railItemTop = (i: number) => i * (rail.item + rail.gap);

export interface ShellProps {
  /** Keep room for the macOS traffic-light buttons (custom title bar). */
  trafficLights?: boolean;
  /** Who draws the plates of the shell regions (default: each its own;
   * `"sheet"`: each region's materials layer, see `PlatePainter`). */
  plates?: PlatePainter;
  children?: JSX.Element;
}

function ShellFrame(props: ShellProps) {
  const regions = createRegions();
  const region = () => (props.plates === "sheet" ? "sheet" : true);
  return (
    <ShellContext.Provider value={regions}>
      <div class="flex h-screen w-screen flex-col overflow-hidden bg-base font-ui text-ink">
        <div
          window-drag
          tk-region={region()}
          class={`relative isolate flex shrink-0 items-center pr-2 ${
            props.trafficLights === false
              ? "pl-3.5"
              : "pl-(--tk-window-buttons) [[data-fullscreen]_&]:pl-3.5"
          }`}
          style={`height: ${topBar.height}px; --tk-window-buttons: ${topBar.reserve}px`}
        >
          <MaterialsLayer />
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
        {/* The plugin container (sidebar layer) is only as wide as the rail
          * and sidebar, tucked 16 px under the stage panel, which paints over
          * it: its texture stays small. Sized to the whole body it was a second
          * window-sized texture, and at full-screen sizes Vello could not fit
          * both in its 8192 px image atlas, so both layers vanished. */}
        <div class="flex min-h-0 flex-1 pr-2 pb-2">
          <Surface
            group={shellGroups.sidebar}
            material="sidebar"
            plate={false}
            join={10}
            class="-mr-4 flex shrink-0"
          >
            <div
              tk-region={region()}
              class="relative isolate flex shrink-0 flex-col items-start"
              style={`width: ${rail.width}px; gap: ${rail.gap}px; padding-left: ${rail.inset}px`}
            >
              <MaterialsLayer />
              <Slot region="rail" />
            </div>
            <Surface.Union radius={12} class="flex pr-4">
              <div tk-region={region()} class="relative isolate flex w-[220px] shrink-0 flex-col gap-0.5 px-1.5 py-2">
                <MaterialsLayer />
                <Slot region="sidebar" />
              </div>
            </Surface.Union>
          </Surface>
            <Surface
              group={shellGroups.stage}
              material="panel"
              radius={[0, 12, 12, 0]}
              join={14}
              plates={props.plates}
              class="min-w-0 flex-1"
            >
              {/* The stage is the stage surface's region (every `Surface` is
                * one). Its materials layer is a sibling of the scroller, so
                * it covers the visible stage only (plates it draws are placed
                * by their on-screen boxes) and paints over the panel and
                * under the scroller's content. */}
              {/* `z-0` makes the scroller a stacking context. Without it Blitz
                * paints any descendant that has a z-index from an ancestor
                * above this element, outside its clip, so scrolled content
                * shows through the top bar. It sits one pixel inside the panel's top and bottom
                * and is clipped to the panel's rounded corners, so scrolled
                * content never covers the panel's hairline: the edge cuts
                * the content, not the other way round. */}
              <div id="shell-stage" class="absolute inset-x-0 inset-y-px z-0 overflow-y-auto rounded-r-[11px]">
                <Slot region="stage" />
              </div>
              {/* Above the scrolled content, so regions of their own. */}
              <div tk-region={region()} class="pointer-events-none absolute inset-x-0 top-0 isolate flex flex-col items-center *:pointer-events-auto">
                <MaterialsLayer />
                <Slot region="stage-top" />
              </div>
              <div tk-region={region()} class="pointer-events-none absolute inset-x-0 bottom-0 isolate flex flex-col items-center *:pointer-events-auto">
                <MaterialsLayer />
                <Slot region="bottom" />
              </div>
            </Surface>
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
