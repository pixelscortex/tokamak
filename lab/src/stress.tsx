/** Stress section: the stress test and the frame-rate readout. Both use
 * render's lab-only `surface-demo` feature (motion runs in the widget, not in
 * JS, so this measures rendering and not the JS wire). */
import { For, Show, createSignal } from "solid-js";
import type { JSX as RenderJSX } from "@tokamak/render/jsx-runtime";
import { Button } from "@tokamak/ui/elements";
import { Shell } from "@tokamak/ui/components";
import { SectionTitle, SidebarHeader, SidebarLabel, SidebarRow, Stepper } from "./kit";

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

const COUNTS = [16, 50, 100, 200, 1000];
const MOVING = ["all", 100, 10, 5, 0] as const;
type Moving = (typeof MOVING)[number];
const STRESS_W = 1060;
const CELL = 36;

/** Frame-rate readout, digits drawn natively. A custom widget would swallow
 * pointer events (wheel too) without `pointer-events-none`. */
function Readout(props: { id: string }) {
  const label = "h-[26px] leading-[18px]";
  return <div id={props.id} class="ml-auto flex shrink-0 gap-2.5 rounded-card bg-sidebar px-3 py-2.5">
    <tk-fps class="pointer-events-none block h-[130px] w-[72px]" />
    <div class="flex flex-col text-[11px] text-ink-3">
      <span class={label}>fps</span><span class={label}>ms / frame</span><span class={label}>ms surfaces</span>
      <span class={label}>kpx dirty</span><span class={label}>frames</span>
    </div>
  </div>;
}

/** 300 keycaps as plates (`material-key` buttons in a `material-tray`).
 * Each paints itself, or the stage's materials layer draws them all (the
 * top bar's "Plates" switch). Static, they re-render nothing; clicking a
 * cap toggles its pressed material (`aria-pressed:`), which re-renders
 * that cap only. */
const CAPS = 300;
function KeycapGrid() {
  const [pressed, setPressed] = createSignal<ReadonlySet<number>>(new Set());
  const toggle = (i: number) => {
    const next = new Set(pressed());
    if (!next.delete(i)) next.add(i);
    setPressed(next);
  };
  return <div id="lab-keycap-grid" class="material-tray flex w-[1037px] flex-wrap gap-[3px] rounded-[10px] p-[3px]">
    <For each={Array.from({ length: CAPS }, (_, i) => i)}>{i =>
      <button id={`lab-grid-cap-${i}`} aria-pressed={pressed().has(i)} onClick={() => toggle(i)}
        class="material-key active:material-key-pressed aria-pressed:material-key-pressed flex h-[26px] w-[44px] items-center justify-center rounded-[6px] border-0 p-0 font-data text-[10px] text-ink-body select-none">
        {i}</button>
    }</For>
  </div>;
}

/** A: N squares in ONE surface, fused where they touch. B: N separate
 * one-square surfaces (no fusing), to show the per-surface cost. C: 300
 * keycap plates in the stage. "moving" keeps only M of
 * the N in motion; the probe is a small unrelated animation, to show what
 * static surfaces cost when something else repaints. */
function Stress() {
  const [running, setRunning] = createSignal(false);
  const [count, setCount] = createSignal(16);
  const [moving, setMoving] = createSignal<Moving>("all");
  const [probe, setProbe] = createSignal(false);
  const [variant, setVariant] = createSignal<"one" | "many" | "keys">("one");
  const cols = Math.floor(STRESS_W / (CELL + 4));
  const moves = (i: number) => running() && (moving() === "all" || i < (moving() as number));
  return <div id="lab-fused-stress" class="flex flex-col gap-4">
    <div class="flex flex-wrap items-start gap-2">
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-1.5">
          <Button id="lab-fused-stress-toggle" pressed={running()} onClick={() => setRunning(!running())}>
            {running() ? "Stop" : "Start"}</Button>
          <Button id="lab-fused-stress-one" pressed={variant() === "one"} onClick={() => setVariant("one")}>
            A · one surface</Button>
          <Button id="lab-fused-stress-many" pressed={variant() === "many"} onClick={() => setVariant("many")}>
            B · N surfaces</Button>
          <Button id="lab-fused-stress-keys" pressed={variant() === "keys"} onClick={() => setVariant("keys")}>
            C · 300 keycaps</Button>
          <Button id="lab-fused-stress-probe" pressed={probe()} onClick={() => setProbe(!probe())}>
            Probe repaint</Button>
          <tk-surface class="size-9 shrink-0" demo="orbit" running={probe() ? "true" : undefined}
            fill="var(--color-panel)" bevel={2} />
        </div>
        <Stepper id="lab-fused-stress" label="total" values={COUNTS} value={count()} set={setCount} />
        <Stepper id="lab-fused-stress-moving" label="moving" values={[...MOVING]} value={moving()} set={setMoving} />
      </div>
      <Readout id="lab-fused-stress-fps" />
    </div>
    <Show when={variant() === "one"}>
      <div class="relative h-[360px] w-[1060px] bg-base">
        <tk-surface id="lab-fused-stress-surface" class="absolute top-0 left-0 h-[360px] w-[1060px]"
          demo="bounce" count={count()} moving={moving()} running={running() ? "true" : undefined}
          fill="var(--color-panel)" join={12} bevel={2} />
      </div>
    </Show>
    <Show when={variant() === "many"}>
      <div class="flex flex-wrap gap-1" style={`width: ${cols * (CELL + 4)}px`}>
        <For each={Array.from({ length: count() }, (_, i) => i)}>{i =>
          <tk-surface class="size-9 shrink-0" demo="orbit" seed={i} running={moves(i) ? "true" : undefined}
            fill="var(--color-panel)" bevel={2} />
        }</For>
      </div>
    </Show>
    <Show when={variant() === "keys"}>
      <KeycapGrid />
    </Show>
  </div>;
}

export default function StressView() {
  return <>
    <Shell.Sidebar>
      <SidebarHeader title="Stress" />
      <SidebarLabel first>Variants</SidebarLabel>
      <SidebarRow label="A · one surface" meta="fused" selected />
      <SidebarRow label="B · N surfaces" meta="atlas" />
      <SidebarRow label="C · 300 keycaps" meta="plates" />
    </Shell.Sidebar>
    <Shell.Stage>
      <div id="lab-stress" class="flex flex-col gap-6 px-8 pt-8 pb-10">
        <SectionTitle eyebrow="STRESS" title="Moving surfaces">
          Motion runs in the widget, not in JS. Stopped means zero repaints: the readout then shows IdLE and
          its frame counter stops.
        </SectionTitle>
        <Stress />
      </div>
    </Shell.Stage>
  </>;
}
