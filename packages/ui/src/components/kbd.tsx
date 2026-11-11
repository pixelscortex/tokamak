/** Kbd: a key or a key combination, as one flat chip in the data font.
 *
 *   <Kbd keys={["cmd", "K"]} />      // ⌘ K
 *   <Kbd keys={["shift", "enter"]} /> // SHIFT ENTER
 *
 * Keys are written in capitals (the data font has no small caps). `cmd`
 * (or `mod`) is drawn as the ⌘ icon, so the key does not depend on the
 * data font having that glyph; arrows and Return are words (`up`,
 * `down`, `enter`) for the same reason. */
import { For, Show } from "solid-js";
import type { JSX } from "@tokamak/render";
import { Icon } from "../elements/icon";
import { icons } from "./icons";

export interface KbdProps {
  /** The keys, in order. */
  keys: readonly string[];
  id?: string;
  class?: string;
}

export function Kbd(props: KbdProps): JSX.Element {
  return (
    <span
      id={props.id}
      class={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded-xs bg-chip px-1.5 font-data text-[11px] leading-[14px] text-ink-3 ${props.class ?? ""}`}
    >
      <For each={props.keys}>
        {(key) => (
          <Show when={key === "cmd" || key === "mod"} fallback={<span>{key.toUpperCase()}</span>}>
            <Icon d={icons.command} strokeWidth={2.25} class="size-2.5" />
          </Show>
        )}
      </For>
    </span>
  );
}
