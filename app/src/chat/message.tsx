import { Show } from "solid-js";
import type { Message as ChatMessage } from "./use-chat";

export function Mark(props: { user?: boolean }) {
  return <span aria-hidden="true" class={`mt-1 flex size-4 shrink-0 items-center justify-center font-label text-[10px] leading-4 ${props.user ? "bg-light text-ground" : "border border-text-3"}`}>
    {props.user ? "K" : ""}
  </span>;
}

export function Message(props: { message: ChatMessage }) {
  return <div class="flex shrink-0 items-start gap-3" data-message={props.message._id} data-status={props.message.status}>
    <Mark user={props.message.role === "user"} />
    <div class="min-w-0 flex-1">
      <p class={`m-0 whitespace-pre-wrap break-words ${props.message.role === "user" ? "text-text" : "text-text-2"}`}>
        {props.message.parts.map(part => part.text).join("")}
      </p>
      <Show when={props.message.status === "streaming"}><p role="status" class="m-0 mt-2 font-label text-[10px] uppercase text-text-3">· working</p></Show>
      <Show when={props.message.status === "error"}><p role="alert" class="m-0 mt-2 text-text-2">{props.message.error ?? "Unable to complete this reply"}</p></Show>
      <Show when={props.message.status === "cancelled"}><p class="m-0 mt-2 font-label text-[10px] uppercase text-text-3">Stopped</p></Show>
    </div>
  </div>;
}
