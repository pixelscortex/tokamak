/** Icons as SVG path data, drawn natively by render's `<tk-icon>` (no SVG
 * renderer involved). Colour follows CSS `color` by default, so text-colour
 * utilities colour icons: `<Icon d={paths.search} class="size-4 text-ink-3" />`.
 * Filled icons pass `fill`, stroke icons keep the default `stroke`. Size the
 * element with utilities (`size-4`); the square viewBox is fitted into it. */
import type { JSX } from "@tokamak/render";

export interface IconProps {
  /** Path data; several sub-paths may be concatenated. */
  d: string;
  /** Square viewBox edge (24 for Lucide-style, 256 for Phosphor). */
  view?: number;
  /** Filled icon instead of stroked. */
  fill?: boolean;
  strokeWidth?: number;
  class?: string;
  id?: string;
}

export function Icon(props: IconProps): JSX.Element {
  return (
    <tk-icon
      id={props.id}
      d={props.d}
      view={props.view}
      fill={props.fill ? "currentColor" : undefined}
      stroke={props.fill ? undefined : "currentColor"}
      stroke-width={props.strokeWidth}
      class={props.class}
    />
  );
}
