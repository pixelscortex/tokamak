/** A compact reference for CSS edges and fused shapes. */
import { createSignal } from "solid-js";
import { Shell, Surface } from "@tokamak/ui/components";
import { SectionTitle } from "./kit";

export default function SurfacesView() {
  const [presses, setPresses] = createSignal(0);
  const sample = "flex h-10 items-center rounded-md bg-chip px-4 font-data text-[11px] text-ink";
  return <Shell.Stage>
    <div id="lab-surfaces" class="flex flex-col gap-7 px-8 pt-8 pb-10">
      <SectionTitle eyebrow="BEVEL" title="A lit edge band">
        Ordinary backgrounds, rounded corners and an edge where you need one.
      </SectionTitle>
      <div id="lab-bevel" class="flex flex-wrap gap-3">
        <div class={`bevel ${sample}`}>bevel</div>
        <div class={`bevel-[3] ${sample}`}>bevel-[3]</div>
        <div class={`bevel-inset ${sample}`}>bevel-inset</div>
        <div class={`bevel bevel-quiet ${sample}`}>bevel-quiet</div>
      </div>
      <div id="lab-field-case" class="flex flex-wrap items-center gap-3">
        <div id="lab-field-card" class="flex items-center gap-3 rounded-[10px] bg-card bevel p-2">
          <input id="lab-field" aria-label="Name" value="A text field"
            class="h-7 w-44 rounded-md border-0 bg-well bevel-inset bevel-1 px-2 text-[13px] text-ink outline-none focus:ring-2 focus:ring-ink-5" />
          <span class="text-[12px] text-ink-2">Field on a card</span>
        </div>
        <button class="h-[30px] rounded-md border-0 bg-chip bevel px-3 text-ink hover:bg-lift active:bg-card">Run</button>
      </div>
      <SectionTitle eyebrow="FUSED SHAPES" title="Add and cut from layout">
        Fill uses surface-panel; corners and edges use the same classes as ordinary elements.
      </SectionTitle>
      <div id="lab-fused" class="flex flex-wrap gap-12 pl-10">
        <Surface id="lab-notch" class="surface-panel rounded-[16px] bevel-[1] bevel-quiet h-[200px] w-[420px]" join={10}>
          <Surface.Add attach="right" class="absolute -left-10 top-16 h-10 w-12 rounded-l-lg" />
          <Surface.Cut slant={[0, 45]} join={14}
            class="absolute top-0 left-[150px] flex h-[42px] w-[140px] items-center justify-center rounded-b-[14px] text-[12px] text-ink-2">
            Session · Today
          </Surface.Cut>
          <p class="absolute top-[80px] left-7 m-0 w-[340px] text-[13px] leading-5 text-ink-3">
            Add a tab with attach. Cut a title notch with slant. Join rounds where shapes meet.
          </p>
        </Surface>
        <Surface id="lab-cutout" class="surface-panel rounded-[20px] bevel h-[200px] w-[420px]">
          <div class="absolute top-7 left-7 flex w-[220px] flex-col gap-2 text-[13px] leading-5 text-ink-2">
            <h2 class="m-0 text-[17px] font-medium text-ink">Shutter</h2>
            <p id="lab-shutter-presses" class="m-0">{presses()} presses</p>
          </div>
          <Surface.Cut join={6} class="absolute top-[60px] right-[60px] size-20 rounded-full">
            <button id="lab-shutter" aria-label="Shutter" onClick={() => setPresses(presses() + 1)}
              class="size-20 rounded-full border-0 bg-chip bevel p-0 text-[34px] text-ink select-none">●</button>
          </Surface.Cut>
        </Surface>
      </div>
    </div>
  </Shell.Stage>;
}
