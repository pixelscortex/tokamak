import { Show } from "solid-js";
import type { NativeEvent } from "@tokamak/render";
import { ComposerInput } from "./composer-input";
import { Mark } from "./message";
import type { ChatState } from "./use-chat";
import type { useDrafts } from "./use-drafts";
import type { useMap } from "./use-map";

export function ChatComposer(props: {
  chat: ChatState;
  composer: ReturnType<typeof useDrafts>;
  map: ReturnType<typeof useMap>;
  mapOpen: boolean;
  onKeyDown: (event: NativeEvent) => void;
}) {
  return (
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
        placeholder={props.mapOpen ? "Search threads" : "Ask anything, or tell Tokamak what to do"}
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
    </div>
  );
}
