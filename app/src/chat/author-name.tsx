import { Show } from "solid-js";
import type { Message } from "./use-chat";

/** Names the author above user messages written by another member. */
export function AuthorName(props: { message: Message; viewerId?: string }) {
  const other = () =>
    props.message.role === "user" &&
    props.viewerId !== undefined &&
    props.message.authorId !== props.viewerId;

  return (
    <Show when={other()}>
      <span
        data-author
        class="mb-1 block font-label text-[9px] leading-4 uppercase tracking-[0.08em] text-text-3"
      >
        {props.message.authorName ?? "Member"}
      </span>
    </Show>
  );
}
