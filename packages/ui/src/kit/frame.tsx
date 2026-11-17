import { For } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Surface } from "../surface.tsx";

export type Theme = "dark" | "light";

export function Themes(props: { children: (theme: Theme) => JSX.Element }): JSX.Element {
  return (
    <div class="grid grid-cols-2">
      <For each={["dark", "light"] as const}>
        {(theme) => (
          <div data-theme={theme} aria-label={`${theme} theme`} role="group">
            <Surface tone="window" class="flex h-full flex-col gap-12 p-8">
              {props.children(theme)}
            </Surface>
          </div>
        )}
      </For>
    </div>
  );
}

export function Section(props: { label: string; title: string; children: JSX.Element }): JSX.Element {
  return (
    <section class="flex flex-col gap-4">
      <div class="flex flex-col gap-1">
        <span class="text-data text-ink-3">{props.label}</span>
        <h3 class="text-read font-semibold text-ink">{props.title}</h3>
      </div>
      {props.children}
    </section>
  );
}

export function Caption(props: { children: JSX.Element }): JSX.Element {
  return <span class="text-label text-ink-3">{props.children}</span>;
}
