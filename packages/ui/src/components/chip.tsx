/** Chip: a small plate with a label, optional secondary text and an
 * optional remove button; `ChipMore` is the "+N more" chip of a row that
 * ran out of room.
 *
 *   <Chip label="Buy milk" detail="Todo" onRemove={() => drop(id)} />
 *   <ChipMore count={3} />
 *
 * `icon` is path data for a leading icon (24 px viewBox, stroked). */
import { Show } from "solid-js";
import type { JSX } from "@tokamak/render";
import { Icon } from "../elements/icon";
import { icons } from "./icons";

export interface ChipProps {
  label: string;
  /** Secondary text after the label (a source, a count), in a dimmer tone. */
  detail?: string;
  /** Leading icon path data. */
  icon?: string;
  /** Shows a remove button; called when it is pressed. */
  onRemove?: () => void;
  id?: string;
  class?: string;
}

const chip = "flex h-6 max-w-[220px] min-w-0 shrink-0 items-center gap-1.5 rounded-sm material-chip pl-2 text-[12px] leading-4";

export function Chip(props: ChipProps): JSX.Element {
  return (
    <span id={props.id} class={`${chip} ${props.onRemove ? "pr-0.5" : "pr-2"} ${props.class ?? ""}`}>
      <Show when={props.icon}>
        <Icon d={props.icon ?? ""} class="size-3 shrink-0 text-ink-3" />
      </Show>
      <span class="min-w-0 truncate text-ink">{props.label}</span>
      <Show when={props.detail}>
        <span class="shrink-0 text-ink-4">{props.detail}</span>
      </Show>
      <Show when={props.onRemove}>
        <button
          type="button"
          id={props.id ? `${props.id}-remove` : undefined}
          aria-label={`Remove ${props.label}`}
          onClick={() => props.onRemove?.()}
          class="flex size-5 shrink-0 items-center justify-center rounded-xs border-0 bg-transparent p-0 text-ink-4 hover:bg-lift hover:text-ink"
        >
          <Icon d={icons.x} strokeWidth={2} class="size-3" />
        </button>
      </Show>
    </span>
  );
}

export interface ChipMoreProps {
  /** How many chips are not shown. */
  count: number;
  id?: string;
  onClick?: () => void;
}

/** "+N more": the last chip of a row that does not show everything. */
export function ChipMore(props: ChipMoreProps): JSX.Element {
  return (
    <button
      type="button"
      id={props.id}
      onClick={() => props.onClick?.()}
      class="flex h-6 shrink-0 items-center rounded-sm border-0 bg-transparent px-2 font-data text-[11px] leading-4 text-ink-3 hover:bg-chip hover:text-ink"
    >
      +{props.count} more
    </button>
  );
}
