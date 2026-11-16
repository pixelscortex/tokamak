import { For, Show, createEffect, createSignal } from "solid-js";
import type { NativeEvent } from "@tokamak/render";
import type { Id } from "@tokamak/sdk";
import type { Sharing } from "./use-shares";

/** Owner-only inline list of members; Enter shares or unshares the open thread. */
export function SharePicker(props: {
  sharing: Sharing;
  threadId: Id<"threads">;
  onClose: () => void;
  onKeyReady: (handler: (event: NativeEvent) => void) => void;
}) {
  const [index, setIndex] = createSignal(0);
  const [error, setError] = createSignal<string>();
  const members = () => props.sharing.members();

  async function toggle(i: number) {
    const member = members()[i];
    if (!member) return;
    setError(undefined);
    try {
      await props.sharing.toggle(props.threadId, member.memberId);
    } catch (cause) {
      setError(String(cause));
    }
  }

  function keydown(event: NativeEvent) {
    if (event.defaultPrevented || event.isComposing) return;
    const key = event.key;
    const count = members().length;

    if (key === "Escape" || key === "Tab") {
      event.preventDefault();
      props.onClose();
    } else if (count && (key === "ArrowDown" || key === "ArrowUp")) {
      event.preventDefault();
      setIndex((i) => (i + (key === "ArrowDown" ? 1 : -1) + count) % count);
    } else if (key === "Enter") {
      event.preventDefault();
      if (!event.repeat) void toggle(index());
    }
  }

  createEffect(() => props.onKeyReady(keydown));

  return (
    <div
      id="share-picker"
      class="flex shrink-0 flex-col gap-2 border border-hairline bg-ground p-3 font-label text-[11px] leading-5 text-text-2"
      onKeyDown={keydown}
    >
      <span class="text-text-3">SHARE THREAD</span>

      <Show
        when={members().length}
        fallback={
          <span id="share-empty" class="text-text-3">
            {props.sharing.loading() ? (
              "Loading members…"
            ) : (
              <>
                Nobody has joined yet. Invite someone from a terminal:
                <br />
                tokamak member invite --url wss://&lt;host&gt;/ws
              </>
            )}
          </span>
        }
      >
        <div role="listbox" aria-label="Members" aria-activedescendant={`share-member-${index()}`}>
          <For each={members()}>
            {(member, i) => {
              const shared = () => props.sharing.has(props.threadId, member.memberId);
              return (
                <button
                  id={`share-member-${i()}`}
                  role="option"
                  aria-selected={index() === i()}
                  aria-checked={shared()}
                  data-member={member.memberId}
                  disabled={props.sharing.loading() || props.sharing.saving()}
                  onClick={() => {
                    setIndex(i());
                    void toggle(i());
                  }}
                  class={`m-0 flex box-border w-full cursor-pointer items-center gap-3 border-0 px-2 py-1 text-left font-label text-[11px] ${index() === i() ? "bg-text text-ground" : "bg-transparent text-text-2"}`}
                >
                  <span
                    aria-hidden="true"
                    class={`box-border size-2 shrink-0 border border-current ${shared() ? "bg-current" : ""}`}
                  />
                  <span class="min-w-0 flex-1">{member.name}</span>
                  <Show when={shared()}>
                    <span class="shrink-0">SHARED</span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      <Show when={error() ?? props.sharing.error()}>
        <span role="alert">{error() ?? props.sharing.error()}</span>
      </Show>
      <span class="text-text-3">↑↓ MOVE · ENTER SHARE / UNSHARE · ESC CLOSE</span>
    </div>
  );
}
