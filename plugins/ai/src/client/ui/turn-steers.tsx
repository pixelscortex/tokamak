import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useClient } from "@tokamak/sdk/client";
import type { MessageProps } from "plugin:chat/client";
import { useTurn } from "../lib/replies";

/**
 * Steers belong to the reply, even after the agent stops or the window
 * reloads. Read from the thread's shared live query, like the rest of the reply.
 */
export function TurnSteers(props: MessageProps): JSX.Element {
  const turn = useTurn(useClient(), props);
  const steers = () => turn()?.steers;
  return (
    <Show when={steers()?.length}>
      <ol aria-label="Steers" class="flex max-w-read flex-col gap-2">
        <For each={steers()}>
          {(text) => (
            <li class="border-s border-edge-strong ps-3">
              <span class="text-label text-ink-3">Steer</span>
              <p class="text-read break-words whitespace-pre-wrap text-ink">{text}</p>
            </li>
          )}
        </For>
      </ol>
    </Show>
  );
}
