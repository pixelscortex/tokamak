import { Show } from "solid-js";

export function BusyStatus(props: { busy: boolean; raced: boolean }) {
  return (
    <Show when={props.busy || props.raced}>
      <span id="chat-busy" role="status" class="mr-2">
        {props.raced ? "Busy: a reply is already running" : "REPLYING"}
      </span>
    </Show>
  );
}
