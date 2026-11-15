import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { JSX, NativeEvent } from "@tokamak/render";
import type { Accessor } from "solid-js";
import type { ComposerProps, ComposerCommand } from "./composer-types";
import { Kbd } from "./kbd";

const COMMAND_ROWS = 6;
const COMMAND_ROW = 30;

export function createComposerCommands(props: ComposerProps, draft: Accessor<string>, setDraft: (text: string) => void) {
  const [closed, setClosed] = createSignal(false);
  createEffect(on(draft, () => setClosed(false), { defer: true }));
  const matches = createMemo(() => {
    const m = /^\/(\S*)$/.exec(draft());
    if (!m || !props.commands?.length || props.form) return [];
    const q = m[1].toLowerCase();
    return props.commands.filter((c) => c.name.toLowerCase().startsWith(q));
  });
  const listing = () => !closed() && matches().length > 0;
  const [active, setActive] = createSignal(0);
  createEffect(on(matches, () => setActive(0)));

  function pickCommand(command: ComposerCommand) {
    setDraft("");
    props.onCommand?.(command);
  }
  function keydown(event: NativeEvent) {
    if (!listing() || event.isComposing) return;
    const n = matches().length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((active() + (event.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      if (!event.repeat) pickCommand(matches()[active()]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setClosed(true);
    }
  }

  return { listing, matches, active, pickCommand, keydown };
}

export function ComposerCommandMenu(props: { ids: (part: string) => string | undefined; commands: ReturnType<typeof createComposerCommands> }): JSX.Element {
  const ids = props.ids;
  return (
    <Show when={props.commands.listing()}>
      <div class="flex flex-col gap-1.5">
        <div
          id={ids("commands")}
          role="listbox"
          class="-mx-2 flex flex-col overflow-y-auto overscroll-contain"
          style={`max-height: ${COMMAND_ROWS * COMMAND_ROW}px`}
        >
          <For each={props.commands.matches()}>
            {(command, i) => (
              <div
                role="option"
                id={ids(`command-${i()}`)}
                data-active={props.commands.active() === i() ? "" : undefined}
                aria-selected={props.commands.active() === i()}
                onClick={() => props.commands.pickCommand(command)}
                class="flex shrink-0 items-center gap-3 rounded-md px-2 hover:bg-chip data-active:bg-chip"
                style={`height: ${COMMAND_ROW}px`}
              >
                <span class="w-24 shrink-0 truncate text-[13px] leading-4 font-medium text-ink">/{command.name}</span>
                <span class="min-w-0 flex-1 truncate text-[13px] leading-4 text-ink-3">{command.description}</span>
                <span class="shrink-0 font-data text-[11px] leading-4 text-ink-5">{command.source}</span>
              </div>
            )}
          </For>
        </div>
        <div class="flex h-5 items-center gap-1.5 text-[12px] leading-4 text-ink-4">
          <Kbd keys={["up"]} />
          <Kbd keys={["down"]} />
          <span class="mr-2">to move</span>
          <Kbd keys={["enter"]} />
          <span class="mr-2">to pick</span>
          <Kbd keys={["esc"]} />
          <span>to close</span>
        </div>
      </div>
    </Show>
  );
}
