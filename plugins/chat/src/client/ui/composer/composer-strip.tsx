import { Slot } from "@tokamak/sdk/client";
import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Kbd } from "@tokamak/ui";
import { composerStripLeft, composerStripRight, useComposer } from "../../lib/composer";

/** Who and where, under the prompt: the agent picker, then one quiet hint. */
export function ComposerStrip(props: { picker: JSX.Element; running: boolean; note?: string }): JSX.Element {
  const composer = useComposer();
  return (
    <div class="flex h-8 min-w-0 items-center gap-2 px-3">
      <Slot of={composerStripLeft} props={{ composer }} />
      {props.picker}
      <span class="flex-1" />
      <Show when={props.note}>
        {(note) => (
          <span role="status" class="text-label text-ink-3">
            {note()}
          </span>
        )}
      </Show>
      <Show when={props.running && !props.note}>
        <span class="flex items-center gap-1 text-label text-ink-3">
          <Kbd keys="esc" /> to stop
        </span>
      </Show>
      <Slot of={composerStripRight} props={{ composer }} />
    </div>
  );
}
