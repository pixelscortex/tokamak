import { Show, createEffect, createSignal } from "solid-js";

/** Run status for the strip above the composer.
 * A lost send race names the member who started the run first. */
export function BusyStatus(props: { starter?: string; raced: boolean }) {
  // Remember the winner so the race message keeps its name after their run ends.
  const [winner, setWinner] = createSignal<string>();
  createEffect(() => { if (props.starter) setWinner(props.starter); });

  return <Show when={props.raced} fallback={
    <Show when={props.starter}><span id="chat-busy" role="status" class="mr-2">REPLYING · {props.starter}</span></Show>
  }>
    <span id="chat-busy" role="status" class="mr-2">Busy: {winner() ?? "someone"} just sent</span>
  </Show>;
}
