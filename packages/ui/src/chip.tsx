/*
  <Chip>feat/csv-export</Chip>
  <Chip mono>invoices.ts <span class="text-added">+42</span> <span class="text-removed">−3</span></Chip>
  <Chip tone="added" label="3 checks passed">✓ 3</Chip>

  One chip carries a small fact: 32 tall (24 with size="sm"), radius 8,
  padding and gap 8, card tone. A tone chip uses its tint and colour and
  must carry a sign or a number, so colour is never the only cue; label
  gives it a spoken name. A chip is not a button.
  Slots: none. data-slot="chip", data-tone, data-size.
*/
import type { JSX } from "@solidjs/web";

export type ChipProps = {
  tone?: "neutral" | "added" | "removed" | "warn" | "info";
  size?: "sm" | "md";
  mono?: boolean;
  label?: string;
  class?: string;
  children: JSX.Element;
};

export function Chip(props: ChipProps): JSX.Element {
  return (
    <span
      data-slot="chip"
      data-tone={props.tone ?? "neutral"}
      data-size={props.size ?? "md"}
      data-mono={props.mono ? "" : undefined}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      class={props.class}
    >
      {props.children}
    </span>
  );
}
