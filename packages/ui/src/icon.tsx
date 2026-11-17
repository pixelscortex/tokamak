/*
  <Icon path={icons.search} />
  <Icon path={icons.check} size={12} label="Saved" />

  One single-colour Remix (or LobeHub) path in a 24 × 24 viewBox, painted
  with currentColor so the parent's tone applies. Without a label it is
  hidden from assistive technology.
  Slots: none. data-slot="icon".
*/
import type { JSX } from "@solidjs/web";

export type IconProps = {
  path: string;
  size?: 12 | 16;
  label?: string;
  class?: string;
};

export function Icon(props: IconProps): JSX.Element {
  return (
    <svg
      data-slot="icon"
      viewBox="0 0 24 24"
      width={props.size ?? 16}
      height={props.size ?? 16}
      class={props.class}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <path d={props.path} fill="currentColor" />
    </svg>
  );
}
