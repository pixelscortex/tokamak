/** Fixtures: markup that tests need and the lab does not show. It is not
 * listed in the sidebar; `lab/tests/fused_surface.rs` opens it with the `lab-test` host
 * event (see app.tsx). Each block is named after what it guards. */
import { For, createSignal } from "solid-js";
import type { JSX } from "@tokamak/render";
import { Sheet, Shell } from "@tokamak/ui/components";
import type { PlatePainter } from "@tokamak/ui/components";

/** Plain backgrounds are plates: a box with an ordinary `bg-[#...]` under
 * the caps it holds (`a_plain_background_is_a_plate_under_the_plates_it_holds`),
 * and `bg-* bevel rounded-*` buttons whose `hover:`, `active:` and
 * `aria-pressed:` variants change the plate through CSS alone
 * (`background_buttons_are_plates_with_css_states`). */
function Backgrounds() {
  // One background button stays down at a time (click again to release).
  const [picked, setPicked] = createSignal<string>();
  const pick = (name: string) => setPicked(picked() === name ? undefined : name);
  const sink = "bevel active:bevel-[0.75] active:bevel-tilt-15 aria-pressed:bevel-[0.75] aria-pressed:bevel-tilt-15 rounded-md";
  const press = "active:material-key-pressed aria-pressed:material-key-pressed";
  const cap = "flex h-[30px] items-center border-0 px-3.5 text-[13px] font-medium select-none";
  return <div id="lab-fixture-plates" class="flex items-center gap-6">
    <div id="lab-plates-order" class="flex gap-[3px] rounded-[12px] bg-[#3a2420] p-3">
      <button id="lab-order-deny" class={`material-key rounded-[7px] ${press} ${cap} text-ink`}>Deny</button>
      <button id="lab-order-allow" class={`material-key-bright rounded-[7px] active:bevel-[0.75] ${cap} text-[#111111]`}>Allow</button>
    </div>
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
  </div>;
}

/** A floating menu is a `Sheet`, a region of its own that paints its own
 * plates (`a_sheet_is_a_region_with_its_own_painter`). */
function Menu() {
  return <div class="relative h-[100px] w-[340px]">
    <p class="m-0 text-[13px] leading-5 text-ink-3">Content under a floating menu.</p>
    <Sheet id="lab-sheet-menu" class="material-card absolute top-2 left-28 flex w-40 flex-col gap-0.5 rounded-[10px] p-1">
      <For each={["Rename", "Duplicate", "Delete"]}>
        {(item, i) => (
          <button id={`lab-sheet-item-${i()}`}
            class={`flex h-[26px] items-center rounded-[7px] border-0 px-2 text-[13px] text-ink select-none hover:material-chip ${i() === 0 ? "material-chip" : ""}`}>
            {item}</button>
        )}
      </For>
    </Sheet>
  </div>;
}

/** The two plate painters side by side, one row per documented difference
 * (`the_two_painters_differ_where_documented`). Every cell is a `Sheet`
 * holding the same elements: its layer draws the plates
 * (`plates="sheet"`), or each plate paints itself. Green stripes are
 * borders, which Blitz always paints: "other content" in both modes. */
function Painters() {
  const modes: PlatePainter[] = ["sheet", "self"];
  const cell = "h-[120px] w-[250px] shrink-0 overflow-hidden rounded-[10px] bg-base";
  const plate = "rounded-md bevel-2";
  const tag = "flex items-center justify-center text-[11px] text-white";
  const row = (body: (mode: PlatePainter) => JSX.Element) =>
    <div class="flex items-center gap-4">
      <For each={modes}>{(mode) => body(mode)}</For>
    </div>;
  return <div id="lab-painters" class="flex flex-col gap-5">
    {/* Covering: a z-indexed bar over a scrolling list. */}
    {row((mode) =>
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
    {/* An ancestor's opacity, and an ancestor moved and scaled. */}
    {row((mode) =>
      <Sheet plates={mode} id={`lab-mode-fx-${mode}`} class={cell}>
        <div class="absolute top-3 left-3 opacity-50">
          <div id={`lab-mode-fx-${mode}-faded`} class={`h-10 w-20 bg-blue-600 ${plate} ${tag}`}>0.5</div>
        </div>
        <div class="absolute top-3 left-[120px] h-10 w-20 border border-solid border-ink-5" />
        <div class="absolute top-3 left-[120px] translate-x-6 translate-y-8 scale-125">
          <div id={`lab-mode-fx-${mode}-moved`} class={`h-10 w-20 bg-blue-600 ${plate} ${tag}`}>moved</div>
        </div>
      </Sheet>)}
    {/* A plate in a nested scroll box, part of it above the box's top edge. */}
    {row((mode) =>
      <Sheet plates={mode} id={`lab-mode-clip-${mode}`} class={cell}>
        <div id={`lab-mode-clip-${mode}-scroll`}
          class="absolute inset-x-3 top-9 h-[72px] overflow-y-auto border border-solid border-ink-5 bg-well">
          <div id={`lab-mode-clip-${mode}-plate`} class={`mx-2 -mt-3 h-10 w-24 bg-blue-600 ${plate} ${tag}`}>plate</div>
          <div class="h-[160px]" />
        </div>
      </Sheet>)}
    {/* z-index: the first plate has z-index 10 and belongs on top. */}
    {row((mode) =>
      <Sheet plates={mode} id={`lab-mode-z-${mode}`} class={cell}>
        <div id={`lab-mode-z-${mode}-front`} class={`absolute top-4 left-4 z-10 h-14 w-28 bg-rose-600 ${plate} ${tag}`}>z-10</div>
        <div id={`lab-mode-z-${mode}-back`} class={`absolute top-10 left-16 h-14 w-28 bg-blue-600 ${plate} ${tag}`}>later</div>
      </Sheet>)}
  </div>;
}

export default function FixturesView() {
  return <>
    <Shell.Stage>
      <div id="lab-fixtures" class="flex flex-col gap-7 px-8 pt-8 pb-10">
        <Backgrounds />
        <Menu />
        <Painters />
      </div>
    </Shell.Stage>
  </>;
}
