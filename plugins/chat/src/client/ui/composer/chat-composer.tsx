import { Slot } from "@tokamak/sdk/client";
import { composerBefore, composerActions, composerAfter, useComposer } from "../../lib/composer";
import { Show } from "solid-js";
import type { NativeEvent } from "@tokamak/render";
import { ComposerInput } from "./composer-input";
import { Mark } from "../messages/message";
import type { ChatState } from "../../lib/state/use-chat";
import type { useDrafts } from "../../lib/state/use-drafts";
import type { useMap } from "../../lib/state/use-map";

export function Composer(props: {
  chat: ChatState;
  composer: ReturnType<typeof useDrafts>;
  map: ReturnType<typeof useMap>;
  mapOpen: boolean;
  onKeyDown: (event: NativeEvent) => void;
}) {
  const composer = useComposer();
  return (
    <>
      <Slot of={composerBefore} props={{ composer }} />
      <div
        class={`flex shrink-0 items-start gap-3 ${props.mapOpen ? "order-1 border-b border-hairline py-3" : ""}`}
      >
        <Show when={!props.mapOpen}>
          <Mark user />
        </Show>
        <ComposerInput
          mapOpen={props.mapOpen}
          autofocus
          id="chat-input"
          aria-label={props.mapOpen ? "Search threads" : "Message"}
          size="md"
          appearance="inherit"
          caret="block"
          class={`chat-input min-w-0 flex-1 ${!props.mapOpen && Boolean(props.chat.active() || props.composer.sending()) ? "chat-input-busy" : ""}`}
          maxRows={props.mapOpen ? 1 : 8}
          placeholder={
            props.mapOpen
              ? "Search threads"
              : props.chat.noAgents()
                ? "No agents found. Install `claude-agent-acp` or `codex-acp` (see README)"
                : "Ask anything, or tell Tokamak what to do"
          }
          value={props.mapOpen ? props.map.query() : props.composer.draft()}
          onValueChange={(text) => {
            if (props.mapOpen) props.map.search(text);
            else {
              props.composer.edit(text);
              props.composer.clearRace();
            }
          }}
          onKeyDown={props.onKeyDown}
          onSubmit={(text) => {
            if (!props.mapOpen) void props.composer.send(text);
          }}
        />
        <Slot of={composerActions} props={{ composer }} />
      </div>
      <Slot of={composerAfter} props={{ composer }} />
    </>
  );
}
