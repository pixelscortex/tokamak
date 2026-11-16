import { For, Show, createMemo } from "solid-js";
import { PermissionPart, type Permission } from "./permission-part";
import { ToolPart } from "./tool-part";
import { Markdown } from "./markdown";
import type { Message as ChatMessage } from "../../lib/state/use-chat";

export function Mark(props: { user?: boolean }) {
  return (
    <span
      aria-hidden="true"
      class={`mt-1 flex size-4 shrink-0 items-center justify-center font-label text-[12px] leading-4 ${props.user ? "bg-light text-ground" : "border border-text-3"}`}
    >
      {props.user ? "K" : ""}
    </span>
  );
}

export function Message(props: {
  message: ChatMessage;
  onAnswer?: (part: Permission, optionId: string) => void;
}) {
  const parts = createMemo(
    () =>
      new Map(
        props.message.parts.map((part, index) => [
          part.type === "tool"
            ? `tool:${part.callId}`
            : part.type === "permission"
              ? `permission:${part.requestId}`
              : `${part.type}:${index}`,
          part,
        ]),
      ),
  );
  const partIds = createMemo(() => [...parts().keys()]);

  const user = () => props.message.role === "user";
  return (
    <div
      class="flex shrink-0 items-start gap-3"
      data-role={props.message.role}
      data-message={props.message._id}
      data-status={props.message.status}
    >
      <Mark user={user()} />
      {/* Give flex a definite starting width. In Blitz beta.4, content sizing
          after a sibling changes can rebreak unchanged inline text at a narrow
          probe width, then reuse its cached full-width box without restoring
          the lines. w-0 lets flex-1 allocate the column without that probe. */}
      <div class="w-0 min-w-0 flex-1">
        <Show
          when={props.message.role === "assistant"}
          fallback={
            <p class="m-0 whitespace-pre-wrap break-words text-text">
              {props.message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}
            </p>
          }
        >
          <div class="flex flex-col gap-3">
            <For each={partIds()}>
              {(id) => {
                const part = () => parts().get(id)!;
                return id.startsWith("text:") ? (
                  <Markdown text={(part() as Extract<ChatMessage["parts"][number], { type: "text" }>).text} />
                ) : id.startsWith("permission:") ? (
                  <PermissionPart
                    part={part() as Permission}
                    onAnswer={
                      props.onAnswer
                        ? (optionId) => props.onAnswer?.(part() as Permission, optionId)
                        : undefined
                    }
                  />
                ) : id.startsWith("plan:") ? (
                  <span class="text-text-3 font-label text-[12px]">
                    {(part() as Extract<ChatMessage["parts"][number], { type: "plan" }>).entries
                      .map((entry) => entry.content)
                      .join(" · ")}
                  </span>
                ) : (
                  <ToolPart part={part() as Extract<ChatMessage["parts"][number], { type: "tool" }>} />
                );
              }}
            </For>
          </div>
        </Show>
        <Show when={props.message.status === "streaming"}>
          <p role="status" class="m-0 mt-2 font-label text-[12px] uppercase text-text-3">
            · working
          </p>
        </Show>
        <Show when={props.message.status === "error"}>
          <p role="alert" class="m-0 mt-2 text-text-2">
            {props.message.error ?? "Unable to complete this reply"}
          </p>
        </Show>
        <Show when={props.message.status === "cancelled"}>
          <p class="m-0 mt-2 font-label text-[12px] uppercase text-text-3">Stopped</p>
        </Show>
      </div>
    </div>
  );
}
