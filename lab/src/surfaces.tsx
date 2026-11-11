/** Surfaces view: a short reference of the styling system
 * (render/SURFACES.md). Plates are ordinary elements with a solid
 * background or a `material-*` class; each paints its own plate. Fused
 * shapes are `Surface` with `Surface.Subtract`. */
import { For, createSignal } from "solid-js";
import type { JSX } from "@tokamak/render";
import { Shell, Surface } from "@tokamak/ui/components";
import { SectionTitle } from "./kit";

/** One labelled row of samples. */
function Row(props: { label: string; children: JSX.Element }) {
  return <div class="flex items-center gap-4">
    <span class="w-32 shrink-0 text-[12px] text-ink-3">{props.label}</span>
    {props.children}
  </div>;
}

/** The lit edge band: the default (sharp), `bevel-soft`, and how strongly
 * it is lit and shaded (`bevel-tilt-<degrees>`, default 35). */
function Bevel() {
  const chip = "bg-chip flex h-[34px] items-center rounded-[8px] px-4 font-data text-[11px] text-ink";
  return <Row label="bevel">
    <div id="lab-bevel" class="flex items-center gap-3">
      <div class={`bevel ${chip}`}>bevel</div>
      <div class={`bevel bevel-soft ${chip}`}>bevel-soft</div>
      <div class={`bevel bevel-tilt-15 ${chip}`}>bevel-tilt-15</div>
      <div class={`bevel bevel-tilt-60 ${chip}`}>bevel-tilt-60</div>
    </div>
  </Row>;
}

/** Keycaps from material classes: every cap is a real `<button>` with a
 * `material-key` class in a `material-tray` (the 3 px of tray between caps
 * is the seam). Pressed states are CSS variants: `active:` while the
 * pointer is down, `aria-pressed:` for a cap that stays down (Always
 * allow, the selected tile). */
function Materials() {
  const [always, setAlways] = createSignal(false);
  const [tile, setTile] = createSignal("CHAT");
  const press = "active:material-key-pressed aria-pressed:material-key-pressed";
  const reset = "border-0 select-none";
  const cap = `${reset} flex h-[30px] items-center px-3.5 text-[13px] font-medium`;
  const small = `material-key ${press} ${reset} flex h-6 min-w-[26px] items-center justify-center rounded-[6px] px-2 font-data text-[10px] tracking-[0.06em] text-ink-body`;
  const tray = "flex w-fit gap-[3px] p-[3px]";
  return <div class="flex flex-col gap-5">
    <div id="lab-keycaps" class="flex flex-col gap-5">
      <Row label="Buttons">
        <div class={`material-tray rounded-[10px] ${tray}`}>
          <button id="lab-key-deny" class={`material-key rounded-[7px] ${press} ${cap} text-ink`}>Deny</button>
          <button id="lab-key-always" class={`material-key rounded-[7px] ${press} ${cap} text-ink`}
            aria-pressed={always()} onClick={() => setAlways(!always())}>Always allow</button>
          <button id="lab-key-once" class={`material-key-bright rounded-[7px] active:bevel-[0.75] ${cap} text-[#111111]`}>Allow once</button>
        </div>
      </Row>
      <Row label="Shortcut keys">
        <div class={`material-tray rounded-[9px] ${tray}`}>
          <button id="lab-key-cmd" class={small}>CMD</button>
          <button class={small}>K</button>
        </div>
        <div class={`material-tray rounded-[9px] ${tray}`}>
          <button class={small}>SHIFT</button>
          <button class={small}>ENTER</button>
        </div>
      </Row>
      <Row label="Plugin tiles">
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
      </Row>
    </div>
    {/* A text field and an inline highlight cannot carry a plate widget of
      * their own: the card they sit on draws their plates with its own. */}
    <div id="lab-field-case">
      <Row label="Field on a card">
        <div id="lab-field-card" class="material-card flex items-center gap-3 rounded-[10px] p-2">
          <input id="lab-field" aria-label="Name" value="A text field"
            class="material-well h-7 w-44 rounded-[6px] border-0 px-2 text-[13px] text-ink outline-none" />
          <p class="m-0 pr-1 text-[12px] leading-5 text-ink-2">
            with an <span id="lab-field-inline" class="rounded-[3px] bg-blue-600 px-1 text-white">inline</span> highlight</p>
        </div>
      </Row>
    </div>
  </div>;
}

/** Fused shapes from layout: a notch hanging from a panel's top edge (its
 * right side leaning 45 degrees into the edge), and a round cut-out with a
 * 3 px gap ring around a control. */
function FusedShapes() {
  const [presses, setPresses] = createSignal(0);
  return <div id="lab-fused" class="flex flex-wrap gap-5">
    <Surface material="panel" radius={16} id="lab-notch" class="h-[200px] w-[420px]">
      <Surface.Subtract slant={[0, 45]} join={14} radius={[0, 0, 14, 14]}
        class="absolute top-0 left-[150px] flex h-[42px] w-[140px] items-center justify-center text-[12px] text-ink-2">
        Session · Today</Surface.Subtract>
      <p class="absolute top-[70px] left-7 m-0 w-[360px] text-[13px] leading-5 text-ink-3">
        Surface.Subtract with slant: the notch is an element, and its box becomes an exact outline.</p>
    </Surface>
    <Surface material="panel" radius={20} id="lab-cutout" class="h-[200px] w-[420px]">
      <div class="absolute top-7 left-7 flex w-[220px] flex-col gap-2 text-[13px] leading-5 text-ink-2">
        <p class="m-0 text-[11px] tracking-[0.08em] text-ink-4">CAPTURE</p>
        <h2 class="m-0 text-[17px] font-medium text-ink">Shutter</h2>
        <p id="lab-shutter-presses" class="m-0">{presses()} presses</p>
      </div>
      <Surface.Subtract radius={40} gap={3} join={6} class="absolute top-[60px] right-[60px] size-20">
        <button id="lab-shutter" aria-label="Shutter" onClick={() => setPresses(presses() + 1)}
          class="size-20 rounded-full border-0 bg-transparent p-0 text-[34px] text-[#3a3a3d] select-none">●</button>
      </Surface.Subtract>
    </Surface>
  </div>;
}

export default function SurfacesView() {
  return <>
    <Shell.Stage>
      <div id="lab-surfaces" class="flex flex-col gap-7 px-8 pt-8 pb-10">
        <SectionTitle eyebrow="BEVEL" title="A lit edge band" />
        <Bevel />
        <SectionTitle eyebrow="MATERIALS" title="Keycaps in a tray">
          Plain buttons with material classes. Each paints its own plate; press them.
        </SectionTitle>
        <Materials />
        <SectionTitle eyebrow="FUSED SHAPES" title="Notches and cut-outs from layout" />
        <FusedShapes />
      </div>
    </Shell.Stage>
  </>;
}
