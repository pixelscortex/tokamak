/** Surfaces section: the fused-surface cases. Most are raw `<tk-surface>`
 * shape lists with fixed pixel geometry, on purpose: they exercise the
 * renderer directly (joins, cuts, gap rings, borders, exact `poly` notches).
 * The layout-bound notch shows the same result from `Surface` members. */
import { For, Show, createSignal } from "solid-js";
import { Input } from "@tokamak/ui/elements";
import { Sheet, Shell, Surface } from "@tokamak/ui/components";
import { SectionTitle, SidebarHeader, SidebarLabel, SidebarRow, Stepper } from "./kit";

type Shape = {
  op: "add" | "sub";
  kind?: "rect" | "circle" | "poly";
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  r?: number | [number, number, number, number];
  /** poly vertices: [x, y] or [x, y, radius]. */
  points?: ([number, number] | [number, number, number])[];
  join?: number;
  gap?: number;
};

const shapes = (list: Shape[]) => JSON.stringify(list);

// Demo cell geometry, shared by the cases.
const W = 520;
const H = 300;
const SHORT = 240;
const RAIL = 46;
const ITEM_TOP = 12;
const ITEM_STEP = 52;
const ITEM_H = 44;

const cell = "relative h-[300px] w-[520px] shrink-0 bg-base";
const shortCell = "relative h-[240px] w-[520px] shrink-0 bg-base";
const layer = "absolute top-0 left-0 h-[300px] w-[520px]";
const shortLayer = "absolute top-0 left-0 h-[240px] w-[520px]";
const content = "absolute z-[1] flex flex-col gap-2 text-[13px] leading-5 text-ink-2";

const rail = [
  { glyph: "●", name: "Notes" },
  { glyph: "■", name: "Tasks" },
  { glyph: "▲", name: "Files" },
  { glyph: "◆", name: "Search" },
  { glyph: "★", name: "Starred" },
];

/** Container plate plus the active tab, fused with r=10 fillets (surface join). */
function railShapes(active: number): string {
  return shapes([
    { op: "add", x: RAIL, y: 0, w: W - RAIL, h: H, r: 12 },
    { op: "add", x: 6, y: ITEM_TOP + active * ITEM_STEP, w: RAIL - 6 + 12, h: ITEM_H, r: [10, 0, 0, 10] },
  ]);
}

function RailTab() {
  const [active, setActive] = createSignal(0);
  return <div class={cell} id="lab-fused-rail">
    <tk-surface class={layer} id="lab-fused-rail-surface"
      fill="var(--color-sidebar)" join={10} bevel={2} shapes={railShapes(active())} />
    <For each={rail}>{(item, index) =>
      <button id={`lab-fused-rail-${index()}`}
        class="absolute z-[1] left-1.5 h-11 w-10 border-0 bg-transparent p-0 text-[15px] text-ink-5 select-none aria-pressed:text-ink"
        style={`top: ${ITEM_TOP + index() * ITEM_STEP}px`} aria-pressed={active() === index()}
        aria-label={item.name} onClick={() => setActive(index())}>{item.glyph}</button>
    }</For>
    <div class={content} style={`left: ${RAIL + 22}px; top: 20px; width: ${W - RAIL - 44}px`}>
      <p class="m-0 text-[11px] tracking-[0.08em] text-ink-4">PLUGIN</p>
      <h2 class="m-0 text-[17px] font-medium text-ink">{rail[active()].name}</h2>
      <p class="m-0">The active rail tab is the container's own material, fused into its left edge.</p>
    </div>
  </div>;
}

/** Panel with a title notch hanging from the top and a docked composer rising
 * from the bottom: both are subtractions, so the base shows through. */
function DockedPanel() {
  const notch = { x: 160, w: 200, h: 38 };
  const composer = { x: 40, y: 214, w: 440 };
  const [draft, setDraft] = createSignal("");
  return <div class={cell} id="lab-fused-panel">
    <tk-surface class={layer} id="lab-fused-panel-surface" fill="var(--color-panel)" bevel={2} shapes={shapes([
      { op: "add", x: 0, y: 0, w: W, h: H, r: 16 },
      { op: "sub", x: notch.x, y: -20, w: notch.w, h: notch.h + 20, r: [0, 0, 14, 14], join: 14 },
      { op: "sub", x: composer.x, y: composer.y, w: composer.w, h: H - composer.y + 40, r: [18, 18, 0, 0], join: 22 },
    ])} />
    <p class={`${content} m-0 items-center justify-center text-[12px] text-ink-2`}
      style={`left: ${notch.x}px; top: 0px; width: ${notch.w}px; height: ${notch.h}px`}>
      Session · Today</p>
    <div class={content} style={`left: 28px; top: 58px; width: ${W - 56}px`}>
      <p class="m-0">Panel material. The title notch and the composer are cut out of it, so the window
        base shows through with concave fillets where they meet the panel edge.</p>
    </div>
    <div class={`${content} flex-row items-center justify-between text-ink-4`}
      style={`left: ${composer.x + 20}px; top: ${composer.y + 22}px; width: ${composer.w - 40}px`}>
      <div class="relative min-w-0 flex-1">
        <Input id="lab-fused-composer-input" aria-label="Message" defaultValue="" onValueChange={setDraft}
          class="h-7! w-full! rounded-none! border-0! bg-transparent! p-0! text-[15px]! text-ink! outline-none!" />
        <Show when={draft() === ""}>
          <span class="pointer-events-none absolute top-1 left-0 text-[15px] text-ink-4">Ask anything…</span>
        </Show>
      </div>
      <span class="text-[12px] text-ink-2 select-none">▲</span>
    </div>
  </div>;
}

/** Round control in a circular notch cut from a plate, separated by a 3 px gap. */
function Cutout() {
  const [presses, setPresses] = createSignal(0);
  const button = { x: 355, y: 110, size: 80 };
  return <div class={cell} id="lab-fused-cutout">
    <tk-surface class={layer} id="lab-fused-cutout-surface" fill="var(--color-panel)" bevel={2} shapes={shapes([
      { op: "add", x: 40, y: 40, w: W - 80, h: H - 80, r: 20 },
      { op: "sub", kind: "circle", x: button.x, y: button.y, w: button.size, h: button.size, gap: 3, join: 6 },
    ])} />
    <div class={content} style="left: 68px; top: 70px; width: 250px">
      <p class="m-0 text-[11px] tracking-[0.08em] text-ink-4">CAPTURE</p>
      <h2 class="m-0 text-[17px] font-medium text-ink">Shutter</h2>
      <p id="lab-fused-presses" class="m-0">{presses()} presses</p>
    </div>
    <button id="lab-fused-shutter" aria-label="Shutter"
      class="absolute z-[1] rounded-full border-0 bg-transparent p-0 text-[34px] text-[#3a3a3d] select-none"
      style={`left: ${button.x}px; top: ${button.y}px; width: ${button.size}px; height: ${button.size}px`}
      onClick={() => setPresses(presses() + 1)}>●</button>
  </div>;
}

/** Plate + fused tab + gap-ring cut-out, so the border crosses a concave join,
 * a convex fillet and a ring. Shared by the flat and the lit variant. */
const borderShapes = shapes([
  { op: "add", x: 30, y: 50, w: W - 60, h: 160, r: 16 },
  { op: "add", x: 60, y: 14, w: 130, h: 60, r: 12, join: 10 },
  { op: "sub", kind: "circle", x: 360, y: 95, w: 70, h: 70, gap: 3, join: 6 },
]);

function BorderCase() {
  const [width, setWidth] = createSignal(1.5);
  const [align, setAlign] = createSignal<"inside" | "center" | "outside">("inside");
  const one = (lit: boolean) =>
    <div class={shortCell} id={`lab-fused-border-${lit ? "lit" : "flat"}`}>
      <tk-surface class={shortLayer} id={`lab-fused-border-${lit ? "lit" : "flat"}-surface`}
        fill="var(--color-panel)" bevel={2} join={10} border={width()} border-align={align()}
        border-color={lit ? "#2c2c2e" : "#3a3a3d"} border-lit={lit ? "true" : undefined} shapes={borderShapes} />
      <p class={`${content} m-0 text-ink-3`} style="left: 52px; top: 120px">
        {lit ? "border-lit: lighter facing the light" : "flat border-color"}</p>
    </div>;
  return <div class="flex flex-col gap-3.5" id="lab-fused-border">
    <div class="flex flex-col gap-2">
      <Stepper id="lab-fused-border-width" label="border" values={[0, 1, 1.5, 2, 3, 4]} value={width()} set={setWidth} unit="px" />
      <Stepper id="lab-fused-border-align" label="align" values={["inside", "center", "outside"] as ("inside" | "center" | "outside")[]}
        value={align()} set={setAlign} />
    </div>
    <div class="flex flex-wrap gap-5">{one(false)}{one(true)}</div>
  </div>;
}

/** Panel outline with a title notch hanging from the top edge and a cut
 * rising from the bottom edge, as ONE exact `poly` (raw shapes), next to the
 * same notch from a layout-bound `Surface.Subtract` with `slant`. */
function NotchCase() {
  const [left, setLeft] = createSignal(0);
  const [right, setRight] = createSignal(45);
  const [join, setJoin] = createSignal(14);
  const [radius, setRadius] = createSignal(14);
  const notch = { x: 190, w: 150, depth: 42 };
  const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
  const outline = () => {
    const jl = notch.x - notch.depth * tan(left());
    const jr = notch.x + notch.w + notch.depth * tan(right());
    // Bottom cut: 64 px tall, sides leaning 30 degrees inward towards the top.
    const lean = 64 * tan(30);
    return shapes([{ op: "add", kind: "poly", points: [
      [0, 0, 16], [jl, 0, join()], [notch.x, notch.depth, radius()],
      [notch.x + notch.w, notch.depth, radius()], [jr, 0, join()], [W, 0, 16],
      [W, SHORT, 16], [440, SHORT, 18], [440 - lean, 176, 16], [80 + lean, 176, 16],
      [80, SHORT, 18], [0, SHORT, 16],
    ] }]);
  };
  const title = "flex items-center justify-center text-[12px] text-ink-2";
  return <div class="flex flex-col gap-3.5" id="lab-fused-notch">
    <div class="flex flex-col gap-2">
      <Stepper id="lab-fused-notch-left" label="left side" values={[0, 15, 30, 45, 60]} value={left()} set={setLeft} unit="°" />
      <Stepper id="lab-fused-notch-right" label="right side" values={[0, 15, 30, 45, 60]} value={right()} set={setRight} unit="°" />
      <Stepper id="lab-fused-notch-join" label="join" values={[0, 6, 14, 24]} value={join()} set={setJoin} />
      <Stepper id="lab-fused-notch-radius" label="corner" values={[0, 6, 14, 20]} value={radius()} set={setRadius} />
    </div>
    <div class="flex flex-wrap gap-5">
      <div class={shortCell} id="lab-fused-notch-panel">
        <tk-surface class={shortLayer} id="lab-fused-notch-surface" fill="var(--color-panel)"
          bevel={2} shapes={outline()} />
        <p class={`${content} m-0 ${title}`} style={`left: ${notch.x}px; top: 0px; width: ${notch.w}px; height: ${notch.depth}px`}>
          Session · Today</p>
        <p class={`${content} m-0 text-ink-3`} style="left: 28px; top: 70px; width: 460px">
          Raw poly: joins and corners are true arcs at any side angle. Bottom: sides at 30°.</p>
      </div>
      <div class="bg-base">
        <Surface material="panel" radius={16} id="lab-fused-notch-bound" class="h-[240px] w-[520px]">
          <Surface.Subtract slant={[left(), right()]} join={join()} radius={[0, 0, radius(), radius()]}
            class={`absolute top-0 left-[190px] h-[42px] w-[150px] ${title}`}>Session · Today</Surface.Subtract>
          <p class="absolute top-[70px] left-7 m-0 w-[460px] text-[13px] leading-5 text-ink-3">
            Layout-bound: the notch is an element; its box and slant become the same exact outline.</p>
        </Surface>
      </div>
    </div>
  </div>;
}

/** Keycaps from the `Surface` primitive only: every cap is a `key` plate
 * (flat face, lit edge band from the one light above) in a recessed `tray`;
 * the 3 px of tray between caps is the seam. No gradients on the face. */
function KeycapCase() {
  const cap = "flex h-[30px] items-center px-3.5 text-[13px] font-medium";
  const small = "flex h-6 min-w-[26px] items-center justify-center px-2 font-data text-[10px] tracking-[0.06em] text-ink-body";
  const tile = "flex h-[58px] w-[74px] flex-col justify-between px-[9px] pt-2 pb-[7px] font-data text-[10px] tracking-[0.06em]";
  const tray = "flex w-fit gap-[3px] p-[3px]";
  return <div id="lab-keycaps" class="flex flex-col gap-5">
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Buttons</span>
      <Surface material="tray" radius={10} class={tray}>
        <Surface material="key" radius={7} class={`${cap} text-ink`}>Deny</Surface>
        <Surface material="key" radius={7} class={`${cap} text-ink`}>Always allow</Surface>
        <Surface material="keyBright" radius={7} class={`${cap} text-[#111111]`}>Allow once</Surface>
      </Surface>
    </div>
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Shortcut keys</span>
      <Surface material="tray" radius={9} class={tray}>
        <Surface material="key" radius={6} class={small}>CMD</Surface>
        <Surface material="key" radius={6} class={small}>K</Surface>
      </Surface>
      <Surface material="tray" radius={9} class={tray}>
        <Surface material="key" radius={6} class={small}>SHIFT</Surface>
        <Surface material="key" radius={6} class={small}>ENTER</Surface>
      </Surface>
    </div>
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Plugin tiles</span>
      <Surface material="tray" radius={12} class={tray}>
        <For each={["CHAT", "TODO", "BOARD", "CODE"]}>
          {(name, i) => (
            <Surface material="key" radius={9} class={`${tile} ${i() === 0 ? "text-ink" : "text-ink-2"}`}>
              <span class="size-[14px] rounded-[3px] bg-current opacity-80" />
              <span>{name}</span>
            </Surface>
          )}
        </For>
      </Surface>
    </div>
  </div>;
}

/** The same keycaps from CSS only: plain elements carry `material-*`
 * utilities, and the stage's materials layer draws every one of them from
 * its computed style (fill, bevel, elevation, border-radius). No `Surface`
 * component, no wrapper per cap, no layer written here. Pressed states are CSS
 * variants: `active:` while the pointer is down, `aria-pressed:` for a
 * toggled cap. The menu floats over other content, so it is a `Sheet`. */
function CssKeycapCase() {
  const [always, setAlways] = createSignal(false);
  const cap = "flex h-[30px] items-center border-0 bg-transparent px-3.5 text-[13px] font-medium select-none";
  const press = "active:material-key-pressed aria-pressed:material-key-pressed";
  const small = "material-key flex h-6 min-w-[26px] items-center justify-center rounded-[6px] px-2 font-data text-[10px] tracking-[0.06em] text-ink-body";
  const tile = "material-key flex h-[58px] w-[74px] flex-col justify-between rounded-[9px] px-[9px] pt-2 pb-[7px] font-data text-[10px] tracking-[0.06em]";
  const tray = "flex w-fit gap-[3px] p-[3px]";
  return <div id="lab-css-keycaps" class="flex flex-col gap-5">
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Buttons</span>
      <div class={`material-tray rounded-[10px] ${tray}`}>
        <button id="lab-css-key-deny" class={`material-key rounded-[7px] ${press} ${cap} text-ink`}>Deny</button>
        <button id="lab-css-key-always" class={`material-key rounded-[7px] ${press} ${cap} text-ink`}
          aria-pressed={always()} onClick={() => setAlways(!always())}>Always allow</button>
        <button id="lab-css-key-once" class={`material-key-bright rounded-[7px] active:bevel-1 ${cap} text-[#111111]`}>Allow once</button>
      </div>
    </div>
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Shortcut keys</span>
      <div class={`material-tray rounded-[9px] ${tray}`}>
        <div class={small}>CMD</div>
        <div class={small}>K</div>
      </div>
      <div class={`material-tray rounded-[9px] ${tray}`}>
        <div class={small}>SHIFT</div>
        <div class={small}>ENTER</div>
      </div>
    </div>
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Plugin tiles</span>
      <div class={`material-tray rounded-[12px] ${tray}`}>
        <For each={["CHAT", "TODO", "BOARD", "CODE"]}>
          {(name, i) => (
            <div class={`${tile} ${i() === 0 ? "text-ink" : "text-ink-2"}`}>
              <span class="size-[14px] rounded-[3px] bg-current opacity-80" />
              <span>{name}</span>
            </div>
          )}
        </For>
      </div>
    </div>
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Menu sheet</span>
      <div class="relative h-[100px] w-[340px]">
        <p class="m-0 text-[13px] leading-5 text-ink-3">
          Content under a floating menu. The menu is a Sheet: its plates are drawn in its own layer, above this text.</p>
        <Sheet id="lab-sheet-menu" class="material-card absolute top-2 left-28 flex w-40 flex-col gap-0.5 rounded-[10px] p-1">
          <For each={["Rename", "Duplicate", "Delete"]}>
            {(item, i) => (
              <button id={`lab-sheet-item-${i()}`}
                class={`flex h-[26px] items-center rounded-[7px] border-0 bg-transparent px-2 text-[13px] text-ink select-none hover:material-chip ${i() === 0 ? "material-chip" : ""}`}>
                {item}</button>
            )}
          </For>
        </Sheet>
      </div>
    </div>
  </div>;
}

/** 300 caps in one tray, for measuring: `css` draws them in the stage's
 * materials layer, `surface` as 300 `<Surface material="key">` (the current way).
 * Clicking a cap toggles its pressed state, in both modes. */
const GRID = 300;
function KeycapGrid() {
  const [mode, setMode] = createSignal<"off" | "css" | "surface">("off");
  const [pressed, setPressed] = createSignal<ReadonlySet<number>>(new Set());
  const toggle = (i: number) => {
    const next = new Set(pressed());
    if (!next.delete(i)) next.add(i);
    setPressed(next);
  };
  const cap = "flex h-[26px] w-[44px] items-center justify-center border-0 bg-transparent p-0 font-data text-[10px] text-ink-body select-none";
  const caps = Array.from({ length: GRID }, (_, i) => i);
  return <div id="lab-keycap-grid" class="flex flex-col gap-3">
    <Stepper id="lab-keycap-grid-mode" label="300 caps" values={["off", "css", "surface"] as ("off" | "css" | "surface")[]}
      value={mode()} set={setMode} />
    <Show when={mode() === "css"}>
      <div class="material-tray flex w-[1037px] flex-wrap gap-[3px] rounded-[10px] p-[3px]">
        <For each={caps}>{i =>
          <button id={`lab-grid-cap-${i}`} class={`material-key aria-pressed:material-key-pressed rounded-[6px] ${cap}`}
            aria-pressed={pressed().has(i)} onClick={() => toggle(i)}>{i}</button>
        }</For>
      </div>
    </Show>
    <Show when={mode() === "surface"}>
      <Surface material="tray" radius={10} class="flex w-[1037px] flex-wrap gap-[3px] p-[3px]">
        <For each={caps}>{i =>
          <Surface material={pressed().has(i) ? "keyPressed" : "key"} radius={6}>
            <button id={`lab-grid-cap-${i}`} class={cap} aria-pressed={pressed().has(i)}
              onClick={() => toggle(i)}>{i}</button>
          </Surface>
        }</For>
      </Surface>
    </Show>
  </div>;
}

export default function SurfacesView() {
  return <>
    <Shell.Sidebar>
      <SidebarHeader title="Surfaces" />
      <SidebarLabel first>Cases</SidebarLabel>
      <SidebarRow label="Rail tab" meta="join" selected />
      <SidebarRow label="Docked panel" meta="cut" />
      <SidebarRow label="Cut-out" meta="gap" />
      <SidebarRow label="Border" meta="lit" />
      <SidebarRow label="Notch angles" meta="poly" />
    </Shell.Sidebar>
    <Shell.Stage>
      <div id="lab-surfaces" class="flex flex-col gap-7 px-8 pt-8 pb-10">
        <SectionTitle eyebrow="SURFACES" title="Fused surfaces">
          One tk-surface element per group: rounded shapes fused by SDF unions and cuts, one light from above.
          Rendered on the GPU; only what changes is re-rendered.
        </SectionTitle>
        <SectionTitle eyebrow="KEYCAPS" title="Buttons as caps in a tray" />
        <KeycapCase />
        <SectionTitle eyebrow="KEYCAPS FROM CSS" title="The same caps from material classes" />
        <CssKeycapCase />
        <KeycapGrid />
        <div class="flex flex-wrap gap-5">
          <RailTab />
          <DockedPanel />
          <Cutout />
        </div>
        <SectionTitle eyebrow="BORDER" title="Border along the fused silhouette" />
        <BorderCase />
        <SectionTitle eyebrow="NOTCH SHAPE" title="Side angle, join and corner" />
        <NotchCase />
      </div>
    </Shell.Stage>
  </>;
}
