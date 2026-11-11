/** Buttons and keys: every Button variant in each state, the sizes, a
 * live toggle, `Kbd` and `Chip`.
 *
 * The hover, pressed and focused columns are the live CSS states held on
 * with the same fills and the ring, forced with `!`.
 * The last column is a live button: hover it, press it, Tab to it. */
import { For, createSignal } from "solid-js";
import { Icon } from "@tokamak/ui/elements";
import { Button, Chip, ChipMore, Kbd, Shell } from "@tokamak/ui/components";
import type { ButtonVariant } from "@tokamak/ui/components";
import { stroke } from "./icons";
import { SectionTitle } from "./kit";

const variants: ButtonVariant[] = ["primary", "neutral", "outline", "destructive", "ghost"];
const states = ["rest", "hover", "pressed", "focused", "disabled", "live"] as const;

/** The classes that hold a state on (see the header). */
function hold(variant: ButtonVariant, state: (typeof states)[number]) {
  if (state === "hover") {
    return variant === "primary" ? "bg-white!" : variant === "outline" ? "bg-card! text-ink!" : variant === "ghost" ? "bg-chip! text-ink!" : "bg-lift!";
  }
  if (state === "pressed") {
    return variant === "primary" ? "bg-ink-body!" : variant === "outline" ? "bg-base!" : "bg-card!";
  }
  if (state === "focused") return "ring-2 ring-ink-5";
  return "";
}

const cell = "flex w-[104px] shrink-0 items-center";
const head = "w-[104px] shrink-0 text-[12px] leading-4 text-ink-4";

export default function ButtonsView() {
  const [presses, setPresses] = createSignal(0);
  const [always, setAlways] = createSignal(false);
  const [chips, setChips] = createSignal(["Buy milk", "lease-2026.pdf", "Weekend groceries"]);
  return (
    <Shell.Stage>
      <div id="lab-buttons" class="flex flex-col gap-8 px-8 pt-8 pb-16">
        <SectionTitle eyebrow="BUTTON" title="Variants and states">
          Flat plates: the fill changes on hover and while pressed. Nothing moves.
          Ghost has no plate until hover.
        </SectionTitle>
        <div class="flex flex-col gap-3">
          <div class="flex items-center">
            <span class={head} />
            <For each={states}>{(state) => <span class={head}>{state}</span>}</For>
          </div>
          <For each={variants}>
            {(variant) => (
              <div class="flex items-center">
                <span class={head}>{variant}</span>
                <For each={states}>
                  {(state) => (
                    <div class={cell}>
                      <Button
                        id={`lab-button-${variant}-${state}`}
                        variant={variant}
                        disabled={state === "disabled"}
                        class={hold(variant, state)}
                        onClick={state === "live" ? () => setPresses(presses() + 1) : undefined}
                      >
                        {variant === "destructive" ? "Delete" : variant === "primary" ? "Run" : "Cancel"}
                      </Button>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
          <p id="lab-button-presses" class="m-0 font-data text-[11px] leading-4 text-ink-4">{presses()} presses</p>
        </div>
        <SectionTitle eyebrow="SIZES" title="sm, md and icon; a toggle" />
        <div class="flex items-center gap-3">
          <Button id="lab-button-sm" size="sm">Small</Button>
          <Button id="lab-button-md">Medium</Button>
          <Button id="lab-button-icon" size="icon" label="Attach">
            <Icon d={stroke.paperclip} class="size-4" />
          </Button>
          <Button size="icon" variant="ghost" label="Mention">
            <Icon d={stroke.atSign} class="size-4" />
          </Button>
          <Button size="icon" variant="primary" round label="Send">
            <Icon d={stroke.arrowUp} strokeWidth={2.25} class="size-4" />
          </Button>
          <span class="w-4" />
          <Button id="lab-button-toggle" pressed={always()} onClick={() => setAlways(!always())}>
            {always() ? "Always allowed" : "Always allow"}
          </Button>
          <Button variant="ghost" size="sm" pressed={always()} onClick={() => setAlways(!always())}>
            Ghost toggle
          </Button>
        </div>
        <SectionTitle eyebrow="KBD" title="Keys and combinations">
          A flat chip in the data font. ⌘ is an icon; arrows and Return are words.
        </SectionTitle>
        <div id="lab-kbd" class="flex items-center gap-3">
          <Kbd keys={["cmd", "K"]} />
          <Kbd keys={["shift", "enter"]} />
          <Kbd keys={["esc"]} />
          <Kbd keys={["up"]} />
          <Kbd keys={["cmd", "shift", "P"]} />
        </div>
        <SectionTitle eyebrow="CHIP" title="Chips, removable, and +N more" />
        <div id="lab-chips" class="flex flex-wrap items-center gap-1.5">
          <For each={chips()}>
            {(label, i) => (
              <Chip id={`lab-chip-${i()}`} label={label} detail={i() === 0 ? "Todo" : undefined} onRemove={() => setChips(chips().filter((c) => c !== label))} />
            )}
          </For>
          <Chip label="Read only" detail="Files" icon={stroke.paperclip} />
          <ChipMore id="lab-chip-more" count={4} />
        </div>
      </div>
    </Shell.Stage>
  );
}
