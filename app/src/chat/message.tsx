import type { PluginLoader } from "@tokamak/runtime/plugins";
import { For, Show, createMemo } from "solid-js";
import { PermissionPart, type Permission } from "./permission-part";
import { ToolPart } from "./tool-part";
import { Markdown } from "./markdown";
import type { Message as ChatMessage } from "./use-chat";

export function Mark(props: { user?: boolean }) {
  return <span aria-hidden="true" class={`mt-1 flex size-4 shrink-0 items-center justify-center font-label text-[10px] leading-4 ${props.user ? "bg-light text-ground" : "border border-text-3"}`}>
    {props.user ? "K" : ""}
  </span>;
}

export function Message(props: { loader: PluginLoader; threadId: string; message: ChatMessage; onAnswer?: (part: Permission, optionId: string) => void; liveCards?: ReadonlySet<string> }) {
  const parts = createMemo(() => new Map(props.message.parts.map((part, index) => [
    part.type === "tool" ? `tool:${part.callId}` : part.type === "permission" ? `permission:${part.requestId}` : `${part.type}:${index}`, part,
  ])));
  const partIds = createMemo(() => [...parts().keys()]);

  return <div class="flex shrink-0 items-start gap-3" data-role={props.message.role} data-message={props.message._id} data-status={props.message.status}>
    <Mark user={props.message.role === "user"} />
    <div class="min-w-0 flex-1">
      <Show when={props.message.role === "assistant"} fallback={
        <p class="m-0 whitespace-pre-wrap break-words text-text">{props.message.parts.map(part => part.type === "text" ? part.text : "").join("")}</p>
      }>
        <div class="flex flex-col gap-3"><For each={partIds()}>{id => {
          const part = () => parts().get(id)!;
          return id.startsWith("text:")
            ? <Markdown text={(part() as Extract<ChatMessage["parts"][number], { type: "text" }>).text} />
            : id.startsWith("permission:")
            ? <PermissionPart part={part() as Permission} onAnswer={optionId => props.onAnswer?.(part() as Permission, optionId)} />
            : id.startsWith("plan:") ? <span class="text-text-3 font-label text-[10px]">{(part() as Extract<ChatMessage["parts"][number], { type: "plan" }>).entries.map(entry => entry.content).join(" · ")}</span>
            : <ToolPart loader={props.loader} part={part() as Extract<ChatMessage["parts"][number], { type: "tool" }>} threadId={props.threadId} live={props.liveCards?.has((part() as Extract<ChatMessage["parts"][number], { type: "tool" }>).callId) ?? true} />;
        }}</For></div>
      </Show>
      <Show when={props.message.status === "streaming"}><p role="status" class="m-0 mt-2 font-label text-[10px] uppercase text-text-3">· working</p></Show>
      <Show when={props.message.status === "error"}><p role="alert" class="m-0 mt-2 text-text-2">{props.message.error ?? "Unable to complete this reply"}</p></Show>
      <Show when={props.message.status === "cancelled"}><p class="m-0 mt-2 font-label text-[10px] uppercase text-text-3">Stopped</p></Show>
    </div>
  </div>;
}
