import { observeLayout } from "@tokamak/render";
import { createSignal, Show } from "solid-js";
import { BusyStatus } from "./busy-status";

export function ComposerStrip(props: {
  title: string;
  backend: string;
  turns: number;
  copied: boolean;
  busy: boolean;
  raced: boolean;
  onBackend?: () => void;
}) {
  const [available, setAvailable] = createSignal(0);
  const [width, setWidth] = createSignal(0);

  // Blitz clips overflow but does not paint CSS text-overflow: ellipsis.
  // Measure the natural single-line title and reserve a real ellipsis glyph.
  return (
    <div
      id="chat-strip"
      class="flex min-w-0 items-center gap-4 border-t border-hairline pt-3 font-label text-[11px] leading-4 uppercase tracking-[0.08em] text-text-3"
    >
      <span
        id="chat-strip-title"
        ref={(node) => observeLayout(node, (layout) => setAvailable(layout.rect.width))}
        title={props.title}
        class="flex min-w-0 flex-1"
      >
        <span class="min-w-0 flex-1 overflow-hidden">
          <span
            ref={(node) => observeLayout(node, (layout) => setWidth(layout.rect.width))}
            class="block w-max whitespace-nowrap"
          >
            {props.title}
          </span>
        </span>
        <Show when={width() > available() + 1}>
          <span class="shrink-0">…</span>
        </Show>
      </span>
      <span id="chat-strip-agent" class="flex shrink-0 items-center gap-2 whitespace-nowrap">
        <Show when={props.copied}>
          <span role="status">COPIED</span>
        </Show>
        <BusyStatus busy={props.busy} raced={props.raced} />

        <Show when={props.onBackend} fallback={<span id="chat-strip-backend">{props.backend}</span>}>
          <button
            aria-label="Change backend (CMD+M)"
            onClick={() => props.onBackend?.()}
            class="m-0 cursor-pointer border-0 bg-transparent p-0 font-label text-[11px] uppercase text-text-3"
          >
            {props.backend}
          </button>
        </Show>
        <span>
          · {props.turns} {props.turns === 1 ? "turn" : "turns"}
        </span>
      </span>
    </div>
  );
}
