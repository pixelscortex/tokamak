/*
  <Icon path={icons.search} />
  <Icon path={icons.check} size={12} label="Saved" />

  One single-colour path in a 24 × 24 box, painted in currentColor. Without
  a label it is hidden from assistive technology.
*/
import type { JSX } from "@solidjs/web";
import { cn } from "./cn.ts";

export type IconProps = { path: string; size?: 12 | 16; label?: string; class?: string };

export function Icon(props: IconProps): JSX.Element {
  return (
    <svg
      data-slot="icon"
      viewBox="0 0 24 24"
      class={cn("block shrink-0", props.size === 12 ? "size-3" : "size-4", props.class)}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <path d={props.path} fill="currentColor" />
    </svg>
  );
}
