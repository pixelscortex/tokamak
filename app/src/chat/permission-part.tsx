import { For, Show } from "solid-js";
import type { Message } from "./use-chat";

export type Permission = Extract<Message["parts"][number], { type: "permission" }>;
export const permissionOptions = (part: Permission) => [...part.options].sort((a, b) =>
  Number(b.kind.startsWith("allow")) - Number(a.kind.startsWith("allow")));

export function PermissionPart(props: { part: Permission; onAnswer?: (optionId: string) => void }) {
  const pending = () => props.part.status === "pending" && props.part.optionId === undefined;
  const chosen = () => props.part.options.find(option => option.optionId === props.part.optionId)?.name;
  return <div data-permission={props.part.requestId} class={`flex flex-wrap items-center gap-2 font-label text-[10px] ${pending() ? "text-text-2" : "text-text-3"}`}>
    <span>{pending() ? "NEEDS YOU · " : ""}{props.part.title}</span>
    <Show when={pending()} fallback={<span>{props.part.status === "expired" || props.part.status === "cancelled" ? props.part.status : chosen()}</span>}>
      <For each={permissionOptions(props.part)}>{option =>
        <button type="button" class="border border-text-3 bg-ground px-2 py-1 font-label text-[10px] text-text-2" onClick={() => props.onAnswer?.(option.optionId)}>{option.name}</button>
      }</For>
    </Show>
  </div>;
}
