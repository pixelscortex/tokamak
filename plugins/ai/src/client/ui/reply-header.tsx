import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useClient } from "@tokamak/sdk/client";
import { Icon } from "@tokamak/ui";
import type { MessageProps } from "plugin:chat/client";
import { agentIcon } from "../lib/icons";
import { useTurn } from "../lib/replies";

/**
 * Above an agent's reply: the agent's mark, its name and the model the turn
 * used ("✳ Claude  opus 5.5"), and nothing else: no persona, no time (Paper
 * "Thread ideas", option C, "Header 8 → first block").
 */
export function ReplyHeader(props: MessageProps): JSX.Element {
  const turn = useTurn(useClient(), props);
  return (
    <header role="group" aria-label="Reply from" class="flex items-center gap-2">
      <Icon path={agentIcon} class="text-ink" />
      <span class="text-label text-ink-3">{turn()?.agent.name ?? props.message.author?.name}</span>
      <Show when={turn()?.modelName ?? turn()?.model}>
        {(model) => <span class="text-data text-ink-3">{model()}</span>}
      </Show>
    </header>
  );
}
