import type { JSX } from "@solidjs/web";
import { useClient } from "@tokamak/sdk/client";
import { refreshAgents } from "../lib/agents";
import { newThreadChoices } from "../lib/choices";

/**
 * The empty thread's heading (Paper "Chat · empty thread"), naming the agent
 * the first Send goes to. Without an agent it keeps chat's own words.
 */
export function AgentHeading(): JSX.Element {
  void refreshAgents(useClient());
  const agent = () => newThreadChoices()?.agent;
  return (
    <h2 class="text-read font-semibold text-ink">
      {agent() ? `What should ${agent()!.name} work on?` : "Start a conversation"}
    </h2>
  );
}
