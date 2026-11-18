import { For, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Caption, Section } from "./frame.tsx";
import { tokenContrast } from "./contrast.ts";

const surfaces = ["window", "stage", "tray", "card", "band"] as const;
const inks = ["ink", "ink-2", "ink-3"] as const;
const semantic = ["added", "removed", "warn", "info"] as const;

const surfaceClass: Record<(typeof surfaces)[number], string> = {
  window: "bg-window",
  stage: "bg-stage",
  tray: "bg-tray",
  card: "bg-card",
  band: "bg-band",
};
const inkClass: Record<(typeof inks)[number], string> = {
  ink: "text-ink",
  "ink-2": "text-ink-2",
  "ink-3": "text-ink-3",
};
const semanticClass: Record<(typeof semantic)[number], [string, string]> = {
  added: ["text-added", "bg-added-tint"],
  removed: ["text-removed", "bg-removed-tint"],
  warn: ["text-warn", "bg-warn-tint"],
  info: ["text-info", "bg-info-tint"],
};

export function Tones(): JSX.Element {
  return (
    <Section label="Tokens · colour" title="Five surfaces, three text tones">
      <div class="grid grid-cols-5 gap-2">
        <For each={surfaces}>
          {(surface) => (
            <div class={`flex flex-col gap-2 rounded-md p-3 ${surfaceClass[surface]}`}>
              <span class="text-row font-medium text-ink">{surface}</span>
              <For each={inks}>{(ink) => <span class={`text-label ${inkClass[ink]}`}>{ink}</span>}</For>
            </div>
          )}
        </For>
      </div>
      <div class="grid grid-cols-4 gap-2">
        <For each={semantic}>
          {(name) => (
            <div class={`flex flex-col gap-1 rounded-md p-3 ${semanticClass[name][1]}`}>
              <span class={`text-data ${semanticClass[name][0]}`}>{name} +12</span>
              <span class="text-label text-ink-2">{name}-tint</span>
            </div>
          )}
        </For>
      </div>
      <div class="flex items-center gap-3">
        <span class="rounded-sm bg-brand px-3 py-1 text-row font-medium text-brand-ink">
          brand / brand-ink
        </span>
        <span class="rounded-sm bg-brand-tint px-3 py-1 text-row text-brand-text">
          brand-text on brand-tint
        </span>
        <a href="#kit" class="text-row link">
          A link is brand-text, underlined
        </a>
      </div>
      <Measured />
    </Section>
  );
}

type Pair = { fg: string; bg: string; ratio: number; need: number };

function measure(root: Element): Pair[] {
  const pairs: Pair[] = [];
  const add = (fg: string, bg: string, need: number) =>
    pairs.push({ fg, bg, need, ratio: tokenContrast(root, fg, bg) });
  for (const ink of inks) for (const surface of surfaces) add(ink, surface, 4.5);
  for (const name of semantic) for (const bg of ["stage", "card", "band", `${name}-tint`]) add(name, bg, 4.5);
  for (const surface of surfaces) add("brand-text", surface, 4.5);
  add("brand-text", "brand-tint", 4.5);
  add("brand-ink", "brand", 4.5);
  add("stage", "ink", 4.5);
  add("stage", "removed", 4.5);
  return pairs;
}

function Measured(): JSX.Element {
  const [pairs, setPairs] = createSignal<Pair[]>([]);
  return (
    <div
      class="flex flex-col gap-2"
      ref={(element) => requestAnimationFrame(() => setPairs(measure(element)))}
    >
      <Caption>
        Measured in this page. Text needs 4.5. The focus ring is brand-text, so the brand-text rows also cover
        it (it needs 3).
      </Caption>
      <div class="grid grid-cols-3 gap-x-4">
        <For each={pairs()}>
          {(pair) => (
            <div class="flex justify-between gap-2 text-data">
              <span class="text-ink-2">
                {pair.fg} / {pair.bg}
              </span>
              <span class={pair.ratio >= pair.need ? "text-ink" : "text-removed"}>
                {pair.ratio.toFixed(2)}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

export function Type(): JSX.Element {
  return (
    <Section label="Tokens · type" title="Three sizes, four roles">
      <div class="flex flex-col gap-3">
        <div class="flex items-baseline gap-4">
          <span class="w-16 shrink-0 text-data text-ink-3">read</span>
          <p class="max-w-read text-read text-ink">
            The cache outlived the token, so the export kept old columns.
          </p>
        </div>
        <div class="flex items-baseline gap-4">
          <span class="w-16 shrink-0 text-data text-ink-3">row</span>
          <span class="text-row text-ink">Ran · Explored · </span>
          <span class="text-row font-medium text-ink">Push the branch</span>
        </div>
        <div class="flex items-baseline gap-4">
          <span class="w-16 shrink-0 text-data text-ink-3">label</span>
          <span class="text-label text-ink-3">Claude Code · 22 passed · waiting for you</span>
        </div>
        <div class="flex items-baseline gap-4">
          <span class="w-16 shrink-0 text-data text-ink-3">data</span>
          <span class="text-data text-ink-3">9.4s +6 −2 2 / 3 opus 4.5</span>
        </div>
      </div>
    </Section>
  );
}

const steps = [
  ["1", "w-1"],
  ["2", "w-2"],
  ["3", "w-3"],
  ["4", "w-4"],
  ["6", "w-6"],
  ["8", "w-8"],
  ["12", "w-12"],
  ["16", "w-16"],
] as const;
const radii = ["rounded-xs", "rounded-sm", "rounded-md", "rounded-lg"] as const;

export function Space(): JSX.Element {
  return (
    <Section label="Tokens · space, radius, depth" title="One scale, base 4">
      <div class="grid grid-cols-2 gap-8">
        <div class="flex flex-col gap-2">
          <For each={steps}>
            {([step, width]) => (
              <div class="flex items-center gap-3">
                <span class="w-8 text-data text-ink-3">{step}</span>
                <span class={`h-2 rounded-xs bg-ink-3 ${width}`} />
                <span class="text-data text-ink-3">{Number(step) * 4}px</span>
              </div>
            )}
          </For>
        </div>
        <div class="flex flex-col gap-4">
          <div class="flex gap-3">
            <For each={radii}>
              {(radius) => (
                <div class={`flex h-12 w-16 items-end bg-card p-1 ${radius}`}>
                  <span class="text-data text-ink-3">{radius.slice(8)}</span>
                </div>
              )}
            </For>
          </div>
          <div class="flex items-center gap-3">
            <span class="rounded-sm bg-card px-3 py-1 text-row text-ink-2">card · flat</span>
            <span class="rounded-sm bg-ink px-3 py-1 text-row font-medium text-stage shadow-raised">
              raised
            </span>
          </div>
          <Caption>shadow-raised means pressable. Nothing else casts one.</Caption>
        </div>
      </div>
    </Section>
  );
}
