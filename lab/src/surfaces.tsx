/** Surfaces section: the fused-surface cases. Most are raw `<tk-surface>`
 * shape lists with fixed pixel geometry, on purpose: they exercise the
 * renderer directly (joins, cuts, gap rings, borders, exact `poly` notches).
 * The layout-bound notch shows the same result from `Surface` members. */
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "@tokamak/render";
import { Input } from "@tokamak/ui/elements";
import { Sheet, Shell, Surface } from "@tokamak/ui/components";
import type { PlatePainter } from "@tokamak/ui/components";
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

/** The two bevel profiles side by side: sharp (the default, an even band
 * with a crisp inner edge) and `bevel-soft` (fading inward). */
function BevelProfiles() {
  return <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Bevel profile</span>
<div id="lab-bevel-profiles" class="flex flex-col gap-3">
        <div class="flex items-center gap-3">
          <button class="bg-chip bevel flex h-[34px] items-center rounded-[8px] border-0 px-4 text-[13px] font-medium text-ink">sharp</button>
          <button class="bg-chip bevel bevel-soft flex h-[34px] items-center rounded-[8px] border-0 px-4 text-[13px] font-medium text-ink">soft</button>
          <button class="bg-blue-600 bevel flex h-[34px] items-center rounded-[8px] border-0 px-4 text-[13px] font-medium text-white">sharp</button>
          <button class="bg-blue-600 bevel bevel-soft flex h-[34px] items-center rounded-[8px] border-0 px-4 text-[13px] font-medium text-white">soft</button>
          <button class="bg-ink bevel flex h-[34px] items-center rounded-[8px] border-0 px-4 text-[13px] font-medium text-[#111111]">sharp</button>
          <button class="bg-ink bevel bevel-soft flex h-[34px] items-center rounded-[8px] border-0 px-4 text-[13px] font-medium text-[#111111]">soft</button>
        </div>
        <div class="flex items-center gap-3">
          <button class="bg-blue-600 bevel-2 bevel-tilt-10 flex h-[34px] items-center rounded-[8px] border-0 px-4 text-[13px] font-medium text-white">tilt 10</button>
          <button class="bg-blue-600 bevel-2 bevel-tilt-20 flex h-[34px] items-center rounded-[8px] border-0 px-4 text-[13px] font-medium text-white">tilt 20</button>
          <button class="bg-blue-600 bevel-2 flex h-[34px] items-center rounded-[8px] border-0 px-4 text-[13px] font-medium text-white">default 35</button>
          <button class="bg-blue-600 bevel-2 bevel-tilt-60 flex h-[34px] items-center rounded-[8px] border-0 px-4 text-[13px] font-medium text-white">tilt 60</button>
          <button class="bg-blue-600 bevel-2 bevel-tilt-90 flex h-[34px] items-center rounded-[8px] border-0 px-4 text-[13px] font-medium text-white">tilt 90</button>
        </div>
      </div>
  </div>;
}

/** Keycaps from material classes: every cap is a real `<button>` with a
 * `material-key` class (flat face, lit edge band from the one light above)
 * in a `material-tray` (the 3 px of tray between caps is the seam). Each
 * paints its own plate from its computed style (or, with the lab's "Plates"
 * switch on "sheet", the stage's materials layer draws them all); no
 * `Surface` component, no layer written here. Pressed states are CSS
 * variants: `active:` while the pointer is down, `aria-pressed:` for a cap
 * that stays down (Always allow, the selected tile). The menu floats over
 * other content, so it is a `Sheet`.
 *
 * Plain backgrounds are plates too: a cap on a box with an ordinary
 * `bg-[#...]` sits on the box (the box is drawn first, and Blitz paints no
 * background over the cap), and `bg-* bevel-*` buttons are caps in any
 * colour. Plates get no UA button background either, so the caps need no
 * `bg-transparent`. */
function KeycapCase() {
  const [always, setAlways] = createSignal(false);
  const [tile, setTile] = createSignal("CHAT");
  // One background button stays down at a time (click again to release).
  const [picked, setPicked] = createSignal<string>();
  const pick = (name: string) => setPicked(picked() === name ? undefined : name);
  // Pressed: the cap goes down, it does not turn inside out. The band gets
  // thinner and flatter and the colour a step darker; the edge stays raised.
  const sink = "bevel active:bevel-[0.75] active:bevel-tilt-15 aria-pressed:bevel-[0.75] aria-pressed:bevel-tilt-15 rounded-md";
  const press = "active:material-key-pressed aria-pressed:material-key-pressed";
  const reset = "border-0 select-none";
  const cap = `${reset} flex h-[30px] items-center px-3.5 text-[13px] font-medium`;
  const small = `material-key ${press} ${reset} flex h-6 min-w-[26px] items-center justify-center rounded-[6px] px-2 font-data text-[10px] tracking-[0.06em] text-ink-body`;
  const tray = "flex w-fit gap-[3px] p-[3px]";
  return <div id="lab-keycaps" class="flex flex-col gap-5">
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Buttons</span>
      <div class={`material-tray rounded-[10px] ${tray}`}>
        <button id="lab-key-deny" class={`material-key rounded-[7px] ${press} ${cap} text-ink`}>Deny</button>
        <button id="lab-key-always" class={`material-key rounded-[7px] ${press} ${cap} text-ink`}
          aria-pressed={always()} onClick={() => setAlways(!always())}>Always allow</button>
        <button id="lab-key-once" class={`material-key-bright rounded-[7px] active:bevel-[0.75] ${cap} text-[#111111]`}>Allow once</button>
      </div>
    </div>
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Coloured box</span>
      <div id="lab-plates-order" class="flex gap-[3px] rounded-[12px] bg-[#3a2420] p-3">
        <button id="lab-order-deny" class={`material-key rounded-[7px] ${press} ${cap} text-ink`}>Deny</button>
        <button id="lab-order-allow" class={`material-key-bright rounded-[7px] active:bevel-[0.75] ${cap} text-[#111111]`}>Allow</button>
      </div>
    </div>
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Backgrounds</span>
      <div id="lab-bg-row" class="flex items-center gap-2">
        <button id="lab-bg-blue" aria-pressed={picked() === "blue"} onClick={() => pick("blue")}
          class={`bg-blue-600 hover:bg-blue-500 active:bg-blue-700 aria-pressed:bg-blue-700 ${sink} ${cap} text-white`}>Run</button>
        <button id="lab-bg-green" aria-pressed={picked() === "green"} onClick={() => pick("green")}
          class={`bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 aria-pressed:bg-emerald-700 ${sink} ${cap} text-white`}>Merge</button>
        <button id="lab-bg-rose" aria-pressed={picked() === "rose"} onClick={() => pick("rose")}
          class={`bg-rose-600 hover:bg-rose-500 active:bg-rose-700 aria-pressed:bg-rose-700 ${sink} ${cap} text-white`}>Delete</button>
        <button id="lab-bg-ghost" aria-pressed={picked() === "ghost"} onClick={() => pick("ghost")}
          class={`bg-white/10 hover:bg-white/15 active:bg-white/5 aria-pressed:bg-white/5 ${sink} ${cap} text-ink`}>Cancel</button>
      </div>
    </div>
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Shortcut keys</span>
      <div class={`material-tray rounded-[9px] ${tray}`}>
        <button id="lab-key-cmd" class={small}>CMD</button>
        <button class={small}>K</button>
      </div>
      <div class={`material-tray rounded-[9px] ${tray}`}>
        <button class={small}>SHIFT</button>
        <button class={small}>ENTER</button>
      </div>
    </div>
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Plugin tiles</span>
      <div class={`material-tray rounded-[12px] ${tray}`}>
        <For each={["CHAT", "TODO", "BOARD", "CODE"]}>
          {(name) => (
            <button id={`lab-key-tile-${name.toLowerCase()}`} aria-pressed={tile() === name} onClick={() => setTile(name)}
              class={`material-key ${press} ${reset} flex h-[58px] w-[74px] flex-col items-start justify-between rounded-[9px] px-[9px] pt-2 pb-[7px] font-data text-[10px] tracking-[0.06em] ${tile() === name ? "text-ink" : "text-ink-2"}`}>
              <span class="size-[14px] rounded-[3px] bg-current opacity-80" />
              <span>{name}</span>
            </button>
          )}
        </For>
      </div>
    </div>
    <div class="flex items-center gap-4">
      <span class="w-24 text-[12px] text-ink-3">Menu sheet</span>
      <div class="relative h-[100px] w-[340px]">
        <p class="m-0 text-[13px] leading-5 text-ink-3">
          Content under a floating menu. The menu is a Sheet: a region of its own, above this text.</p>
        <Sheet id="lab-sheet-menu" class="material-card absolute top-2 left-28 flex w-40 flex-col gap-0.5 rounded-[10px] p-1">
          <For each={["Rename", "Duplicate", "Delete"]}>
            {(item, i) => (
              <button id={`lab-sheet-item-${i()}`}
                class={`flex h-[26px] items-center rounded-[7px] border-0 px-2 text-[13px] text-ink select-none hover:material-chip ${i() === 0 ? "material-chip" : ""}`}>
                {item}</button>
            )}
          </For>
        </Sheet>
      </div>
    </div>
  </div>;
}

/** Plates on elements that cannot carry a widget, inside a self-painting
 * plate: a text field (its element holds the text editor) and an inline
 * highlight (no box of its own). The card around them draws their plates
 * with its own, so the field keeps its recessed well on the card; with the
 * "Plates" switch on "sheet" the stage's layer draws all three. */
function FieldCase() {
  return <div id="lab-field-case" class="flex items-center gap-4">
    <span class="w-24 text-[12px] text-ink-3">Field on a card</span>
    <div id="lab-field-card" class="material-card flex items-center gap-3 rounded-[10px] p-2">
      <input id="lab-field" aria-label="Name" value="A text field"
        class="material-well h-7 w-44 rounded-[6px] border-0 px-2 text-[13px] text-ink outline-none" />
      <p class="m-0 pr-1 text-[12px] leading-5 text-ink-2">
        with an <span id="lab-field-inline" class="rounded-[3px] bg-blue-600 px-1 text-white">inline</span> highlight</p>
    </div>
  </div>;
}

/** The two plate painters side by side, one row per difference. Every cell
 * is a `Sheet` (a region of its own) holding the same elements: on the left
 * its materials layer draws the plates (`plates="sheet"`), on the right each
 * plate paints itself (the default). `lab/tests/fused_surface.rs` asserts
 * the pixels of each cell. Green stripes are borders, which Blitz always
 * paints itself: they stand for "other content" in both modes. */
function PainterCases() {
  const modes: PlatePainter[] = ["sheet", "self"];
  const cell = "h-[120px] w-[250px] shrink-0 overflow-hidden rounded-[10px] bg-base";
  const plate = "rounded-md bevel-2";
  const tag = "flex items-center justify-center text-[11px] text-white";
  const row = (name: string, text: string, body: (mode: PlatePainter) => JSX.Element) =>
    <div class="flex items-center gap-4">
      <span class="w-24 shrink-0 text-[12px] leading-4 text-ink-3">{name}</span>
      <For each={modes}>{(mode) =>
        <div class="flex flex-col gap-1.5">
          <span class="font-data text-[10px] tracking-[0.06em] text-ink-4">{mode === "sheet" ? "SHEET" : "SELF-PAINTING"}</span>
          {body(mode)}
        </div>
      }</For>
      <p class="m-0 w-[300px] text-[12px] leading-[18px] text-ink-3">{text}</p>
    </div>;
  return <div id="lab-painters" class="flex flex-col gap-5">
    {row("Covering", "A bar above a scrolling list (z-index). Its background should hide the lines and stripes under it.", (mode) =>
      <Sheet plates={mode} id={`lab-mode-cover-${mode}`} class={cell}>
        <div id={`lab-mode-cover-${mode}-scroll`} class="h-full overflow-y-auto px-3">
          <For each={[1, 2, 3, 4, 5, 6, 7, 8]}>{(i) => <>
            <p class="m-0 text-[12px] leading-5 text-ink-2">Scrolled line {i}</p>
            <div class="h-0 border-0 border-t-[10px] border-solid border-emerald-500" />
          </>}</For>
        </div>
        <div id={`lab-mode-cover-${mode}-bar`}
          class="absolute inset-x-0 top-0 z-10 flex h-9 items-center bg-rose-700 bevel-2 px-3 text-[12px] text-white">Bar</div>
      </Sheet>)}
    {row("Opacity, transform", "Left: the parent has opacity 0.5. Right: the parent is moved and scaled; the outline is where layout put it.", (mode) =>
      <Sheet plates={mode} id={`lab-mode-fx-${mode}`} class={cell}>
        <div class="absolute top-3 left-3 opacity-50">
          <div id={`lab-mode-fx-${mode}-faded`} class={`h-10 w-20 bg-blue-600 ${plate} ${tag}`}>0.5</div>
        </div>
        <div class="absolute top-3 left-[120px] h-10 w-20 border border-solid border-ink-5" />
        <div class="absolute top-3 left-[120px] translate-x-6 translate-y-8 scale-125">
          <div id={`lab-mode-fx-${mode}-moved`} class={`h-10 w-20 bg-blue-600 ${plate} ${tag}`}>moved</div>
        </div>
      </Sheet>)}
    {row("Nested scroll", "A plate inside a small scrolling box (a plate itself), part of it above the box's top edge. Scroll the box.", (mode) =>
      <Sheet plates={mode} id={`lab-mode-clip-${mode}`} class={cell}>
        <div id={`lab-mode-clip-${mode}-scroll`}
          class="absolute inset-x-3 top-9 h-[72px] overflow-y-auto border border-solid border-ink-5 bg-well">
          <div id={`lab-mode-clip-${mode}-plate`} class={`mx-2 -mt-3 h-10 w-24 bg-blue-600 ${plate} ${tag}`}>plate</div>
          <div class="h-[160px]" />
        </div>
      </Sheet>)}
    {row("z-index", "Two overlapping plates. The red one comes first in the document and has z-index 10, so it belongs on top.", (mode) =>
      <Sheet plates={mode} id={`lab-mode-z-${mode}`} class={cell}>
        <div id={`lab-mode-z-${mode}-front`} class={`absolute top-4 left-4 z-10 h-14 w-28 bg-rose-600 ${plate} ${tag}`}>z-10</div>
        <div id={`lab-mode-z-${mode}-back`} class={`absolute top-10 left-16 h-14 w-28 bg-blue-600 ${plate} ${tag}`}>later</div>
      </Sheet>)}
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
        <SectionTitle eyebrow="KEYCAPS" title="Buttons as caps in a tray">
          Plain buttons with material classes. Each paints its own plate; press them.
        </SectionTitle>
        <KeycapCase />
        <BevelProfiles />
        <FieldCase />
        <SectionTitle eyebrow="PLATE PAINTERS" title="The sheet and self-painting, side by side">
          The same elements twice: drawn by the region's one layer, and each painting itself.
        </SectionTitle>
        <PainterCases />
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
