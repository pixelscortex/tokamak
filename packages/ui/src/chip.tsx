/*
  <Chip>feat/csv-export</Chip>
  <Chip tone="added" label="3 checks passed">✓ 3</Chip>

  One small fact: 32 tall (24 with size="sm"), radius 8. A tone chip carries
  a sign or a number too, never colour alone. A chip is not a button.
*/
import type { JSX } from "@solidjs/web";
import { cn, tv } from "./cn.ts";

export const chipVariants = tv({
  base: "inline-flex items-center gap-2 rounded-sm px-2 whitespace-nowrap",
  variants: {
    tone: {
      neutral: "bg-edge text-ink",
      added: "bg-added-tint text-added",
      removed: "bg-removed-tint text-removed",
      warn: "bg-warn-tint text-warn",
      info: "bg-info-tint text-info",
    },
    size: { md: "h-8 text-row", sm: "h-6 text-label" },
    mono: { true: "text-data" },
  },
  defaultVariants: { tone: "neutral", size: "md" },
});

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
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      class={cn(chipVariants({ tone: props.tone, size: props.size, mono: props.mono }), props.class)}
    >
      <span class="text-trim">{props.children}</span>
    </span>
  );
}
