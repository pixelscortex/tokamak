/** Fused surfaces in the lab (render/src/surface, render/SURFACES.md). Each
 * <tk-surface> is one group: only its own shapes merge or subtract, and it
 * paints only its own box. Geometry is fixed CSS px computed here; real DOM
 * content sits above it. The stress test and frame-rate readout use the
 * lab-only `surface-demo` feature of render. */
import { For, Show, createSignal } from "solid-js";
import { Button, Input } from "@tokamak/ui/elements";
import type { JSX as RenderJSX } from "@tokamak/render/jsx-runtime";

// Lab-only attributes and element (render's `surface-demo` feature), kept out
// of the product typings.
declare module "@tokamak/render/jsx-runtime" {
  namespace JSX {
    interface SurfaceAttributes {
      /** Stress demo driven natively: `bounce` uses `count`/`moving`, `orbit` uses `seed`. */
      demo?: "bounce" | "orbit";
      count?: number;
      moving?: number | "all";
      seed?: number;
      running?: string;
    }
    interface IntrinsicElements {
      /** Frame-rate readout (render/src/surface/fps.rs). */
      "tk-fps": RenderJSX.Attributes;
    }
  }
}

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

// Demo cell geometry, shared by every composition.
const W = 520;
const H = 300;
const RAIL = 46;
const ITEM_TOP = 12;
const ITEM_STEP = 52;
const ITEM_H = 44;

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

function RailTab(props: { active: number; select: (index: number) => void }) {
  return <div class="fused-demo" id="lab-fused-rail">
    <tk-surface class="fused-layer" id="lab-fused-rail-surface"
      fill="#121212" join={10} bevel={2} shapes={railShapes(props.active)} />
    <For each={rail}>{(item, index) =>
      <button id={`lab-fused-rail-${index()}`} class="fused-rail-item"
        style={`top: ${ITEM_TOP + index() * ITEM_STEP}px`} aria-pressed={props.active === index()}
        aria-label={item.name} onClick={() => props.select(index())}>{item.glyph}</button>
    }</For>
    <div class="fused-content" style={`left: ${RAIL + 22}px; top: 20px; width: ${W - RAIL - 44}px`}>
      <p class="eyebrow">PLUGIN</p>
      <h2>{rail[props.active].name}</h2>
      <p>The active rail tab is the container's own material, fused into its left edge.</p>
    </div>
  </div>;
}

/** Panel with a title notch hanging from the top and a docked composer rising
 * from the bottom: both are subtractions, so the base shows through. */
function DockedPanel() {
  const notch = { x: 160, w: 200, h: 38 };
  const composer = { x: 40, y: 214, w: 440 };
  const [draft, setDraft] = createSignal("");
  return <div class="fused-demo" id="lab-fused-panel">
    <tk-surface class="fused-layer" id="lab-fused-panel-surface" fill="#1b1b1b" bevel={2} shapes={shapes([
      { op: "add", x: 0, y: 0, w: W, h: H, r: 16 },
      { op: "sub", x: notch.x, y: -20, w: notch.w, h: notch.h + 20, r: [0, 0, 14, 14], join: 14 },
      { op: "sub", x: composer.x, y: composer.y, w: composer.w, h: H - composer.y + 40, r: [18, 18, 0, 0], join: 22 },
    ])} />
    <p class="fused-content fused-notch" style={`left: ${notch.x}px; top: 0px; width: ${notch.w}px; height: ${notch.h}px`}>
      Session · Today</p>
    <div class="fused-content" style={`left: 28px; top: 58px; width: ${W - 56}px`}>
      <p>Panel #1B1B1B. The title notch and the composer are cut out of it, so the window
        base shows through with concave fillets where they meet the panel edge.</p>
    </div>
    <div class="fused-content fused-composer" style={`left: ${composer.x + 20}px; top: ${composer.y + 22}px; width: ${composer.w - 40}px`}>
      <Input id="lab-fused-composer-input" class="fused-input" aria-label="Message" defaultValue=""
        onValueChange={setDraft} />
      <Show when={draft() === ""}><span class="fused-placeholder">Ask anything…</span></Show>
      <span class="fused-send">▲</span>
    </div>
  </div>;
}

/** Round control in a circular notch cut from a plate, separated by a 3 px gap. */
function Cutout() {
  const [presses, setPresses] = createSignal(0);
  const button = { x: 355, y: 110, size: 80 };
  return <div class="fused-demo" id="lab-fused-cutout">
    <tk-surface class="fused-layer" id="lab-fused-cutout-surface" fill="#1b1b1b" bevel={2} shapes={shapes([
      { op: "add", x: 40, y: 40, w: W - 80, h: H - 80, r: 20 },
      { op: "sub", kind: "circle", x: button.x, y: button.y, w: button.size, h: button.size, gap: 3, join: 6 },
    ])} />
    <div class="fused-content" style="left: 68px; top: 70px; width: 250px">
      <p class="eyebrow">CAPTURE</p>
      <h2>Shutter</h2>
      <p id="lab-fused-presses">{presses()} presses</p>
    </div>
    <button id="lab-fused-shutter" class="fused-shutter" aria-label="Shutter"
      style={`left: ${button.x}px; top: ${button.y}px; width: ${button.size}px; height: ${button.size}px`}
      onClick={() => setPresses(presses() + 1)}>●</button>
  </div>;
}

/** A row of value buttons: the playground's stand-in for a slider. */
function Stepper<T extends string | number>(props: {
  id: string; label: string; values: T[]; value: T; set: (value: T) => void; unit?: string;
}) {
  return <div class="fused-stepper">
    <span class="fused-stepper-label">{props.label}</span>
    <For each={props.values}>{v =>
      <Button id={`${props.id}-${v}`} pressed={props.value === v} onClick={() => props.set(v)}>
        {`${v}${props.unit ?? ""}`}</Button>
    }</For>
  </div>;
}

const BORDER_H = 240;

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
  const cell = (lit: boolean) =>
    <div class="fused-demo fused-short" id={`lab-fused-border-${lit ? "lit" : "flat"}`}>
      <tk-surface class="fused-layer fused-short" id={`lab-fused-border-${lit ? "lit" : "flat"}-surface`} fill="#1b1b1b" bevel={2} join={10} border={width()} border-align={align()}
        border-color={lit ? "#2c2c2e" : "#3a3a3d"} border-lit={lit ? "true" : undefined} shapes={borderShapes} />
      <p class="fused-content fused-caption" style="left: 52px; top: 120px">
        {lit ? "border-lit: lighter facing the light" : "flat border-color"}</p>
    </div>;
  return <div class="fused-play" id="lab-fused-border">
    <div class="fused-controls">
      <Stepper id="lab-fused-border-width" label="border" values={[0, 1, 1.5, 2, 3, 4]} value={width()} set={setWidth} unit="px" />
      <Stepper id="lab-fused-border-align" label="align" values={["inside", "center", "outside"] as ("inside" | "center" | "outside")[]}
        value={align()} set={setAlign} />
    </div>
    <div class="fused-grid">{cell(false)}{cell(true)}</div>
  </div>;
}

/** Panel outline with a title notch hanging from the top edge and a cut
 * rising from the bottom edge, as ONE exact `poly`: every vertex is replaced
 * by a true tangent arc of its own radius, so the join where a slanted side
 * meets the panel edge is a circular arc of radius `join` at any angle, and
 * the notch's own corners are arcs of radius `corner`. Angles are degrees
 * from vertical; positive leans the side outward towards the panel edge. */
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
      [W, BORDER_H, 16], [440, BORDER_H, 18], [440 - lean, 176, 16], [80 + lean, 176, 16],
      [80, BORDER_H, 18], [0, BORDER_H, 16],
    ] }]);
  };
  return <div class="fused-play" id="lab-fused-notch">
    <div class="fused-controls">
      <Stepper id="lab-fused-notch-left" label="left side" values={[0, 15, 30, 45, 60]} value={left()} set={setLeft} unit="°" />
      <Stepper id="lab-fused-notch-right" label="right side" values={[0, 15, 30, 45, 60]} value={right()} set={setRight} unit="°" />
      <Stepper id="lab-fused-notch-join" label="join" values={[0, 6, 14, 24]} value={join()} set={setJoin} />
      <Stepper id="lab-fused-notch-radius" label="corner" values={[0, 6, 14, 20]} value={radius()} set={setRadius} />
    </div>
    <div class="fused-grid">
      <div class="fused-demo fused-short" id="lab-fused-notch-panel">
        <tk-surface class="fused-layer fused-short" id="lab-fused-notch-surface" fill="#1b1b1b"
          bevel={2} shapes={outline()} />
        <p class="fused-content fused-notch" style={`left: ${notch.x}px; top: 0px; width: ${notch.w}px; height: ${notch.depth}px`}>
          Session · Today</p>
        <p class="fused-content fused-caption" style="left: 28px; top: 70px; width: 460px">
          One exact outline: joins and corners are true arcs at any side angle. Bottom: sides at 30°.</p>
      </div>
    </div>
  </div>;
}

const COUNTS = [16, 50, 100, 200, 1000];
const MOVING = ["all", 100, 10, 5, 0] as const;
type Moving = (typeof MOVING)[number];
const STRESS_W = 1060;
const STRESS_H = 360;
const CELL = 36;

/** Stress test. Motion is generated and advanced inside the widget (Rust), so
 * this measures rendering, not the JS wire. A: N squares in ONE surface, fused
 * where they touch. B: N separate one-square surfaces (no fusing), to show the
 * per-surface cost. "moving" keeps only M of the N in motion; the probe is a
 * small unrelated animation, to show what static surfaces cost when something
 * else on the page repaints. */
function Stress() {
  const [running, setRunning] = createSignal(false);
  const [count, setCount] = createSignal(16);
  const [moving, setMoving] = createSignal<Moving>("all");
  const [probe, setProbe] = createSignal(false);
  const [variant, setVariant] = createSignal<"one" | "many">("one");
  const cols = Math.floor(STRESS_W / (CELL + 4));
  const moves = (i: number) => running() && (moving() === "all" || i < (moving() as number));
  return <div class="fused-stress" id="lab-fused-stress">
    <div class="fused-stress-bar">
      <div class="fused-controls">
        <div class="fused-stepper">
          <Button id="lab-fused-stress-toggle" pressed={running()} onClick={() => setRunning(!running())}>
            {running() ? "Stop" : "Start"}</Button>
          <Button id="lab-fused-stress-one" pressed={variant() === "one"} onClick={() => setVariant("one")}>
            A · one surface</Button>
          <Button id="lab-fused-stress-many" pressed={variant() === "many"} onClick={() => setVariant("many")}>
            B · N surfaces</Button>
          <Button id="lab-fused-stress-probe" pressed={probe()} onClick={() => setProbe(!probe())}>
            Probe repaint</Button>
          <tk-surface class="fused-probe" demo="orbit" running={probe() ? "true" : undefined}
            fill="#1b1b1b" bevel={2} />
        </div>
        <Stepper id="lab-fused-stress" label="total" values={COUNTS} value={count()} set={setCount} />
        <Stepper id="lab-fused-stress-moving" label="moving" values={[...MOVING]} value={moving()} set={setMoving} />
      </div>
      <FpsOverlay id="lab-fused-stress-fps" />
    </div>
    <Show when={variant() === "one"}>
      <div class="fused-stress-area" style={`width: ${STRESS_W}px; height: ${STRESS_H}px`}>
        <tk-surface id="lab-fused-stress-surface" class="fused-stress-layer" demo="bounce" count={count()}
          moving={moving()} running={running() ? "true" : undefined} fill="#1b1b1b" join={12}
          bevel={2} style={`width: ${STRESS_W}px; height: ${STRESS_H}px`} />
      </div>
    </Show>
    <Show when={variant() === "many"}>
      <div class="fused-stress-grid" style={`width: ${cols * (CELL + 4)}px`}>
        <For each={Array.from({ length: count() }, (_, i) => i)}>{i =>
          <tk-surface class="fused-stress-cell" demo="orbit" seed={i} running={moves(i) ? "true" : undefined} fill="#1b1b1b" bevel={2} />
        }</For>
      </div>
    </Show>
  </div>;
}

/** Frame-rate readout (render/src/fps.rs), digits drawn natively. Inline, not
 * fixed: in Blitz beta.4 `position: fixed` lays out like `absolute` against
 * the page, so a "fixed" corner would scroll away. */
function FpsOverlay(props: { id: string }) {
  return <div class="fused-fps" id={props.id}>
    <tk-fps class="fused-fps-digits" />
    <div class="fused-fps-labels"><span>fps</span><span>ms / frame</span><span>ms surfaces</span><span>kpx dirty</span><span>frames</span></div>
  </div>;
}

export default function FusedSurfaces() {
  const [active, setActive] = createSignal(0);
  return <section class="fused" id="lab-fused">
    <header class="fused-header">
      <div class="fused-title-row">
        <div class="fused-header">
          <p class="eyebrow">PROOF OF CONCEPT · NATIVE CUSTOM WIDGET</p>
          <h2>Fused surfaces</h2>
        </div>
        <FpsOverlay id="lab-fused-fps" />
      </div>
      <p>One tk-surface element per group: rounded shapes fused by SDF unions and cuts, one light from above.
        Rendered on the GPU; only what changes is re-rendered.</p>
    </header>
    <div class="fused-grid">
      <RailTab active={active()} select={setActive} />
      <DockedPanel />
      <Cutout />
    </div>
    <header class="fused-header fused-stress-header">
      <p class="eyebrow">BORDER</p>
      <h2>Border along the fused silhouette</h2>
    </header>
    <BorderCase />
    <header class="fused-header fused-stress-header">
      <p class="eyebrow">NOTCH SHAPE</p>
      <h2>Side angle, join and corner</h2>
    </header>
    <NotchCase />
    <header class="fused-header fused-stress-header">
      <p class="eyebrow">STRESS</p>
      <h2>Moving surfaces</h2>
      <p>Motion runs in the widget, not in JS. Stopped means zero repaints: the readout in the corner then shows IdLE
        and its frame counter stops.</p>
    </header>
    <Stress />
  </section>;
}
