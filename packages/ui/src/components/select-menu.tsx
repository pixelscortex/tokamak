import { For, Show, createMemo } from "solid-js";
import type { Accessor } from "solid-js";
import type { JSX, NativeNode } from "@tokamak/render";
import { Icon } from "../elements/icon";
import { dismissable } from "./dismiss";
import { place, trackLayout } from "./floating";
import { icons } from "./icons";
import type { SelectProps, createSelectState } from "./select";

const GAP = 6;
const MARGIN = 8;
const LIST_MAX = 264;

export function SelectMenu(props: SelectProps & { state: ReturnType<typeof createSelectState> }): JSX.Element {
    const { query, search, rows, active, value, pick, compact, sub } = props.state;
    props.state.setLayer(dismissable(() => props.state.setOpen(false)));
    const [anchor, observeAnchor] = trackLayout();
    const [menu, observeMenu] = trackLayout();
    const [list, observeList] = trackLayout();
    const [content, observeContent] = trackLayout();
    const trigger = props.state.trigger();
    if (trigger) observeAnchor(trigger);
    /** Everything in CSS px relative to the trigger's box. */
    const at = createMemo(() => {
      const a = anchor();
      if (!a) return undefined;
      const { width: tw, height: th } = a.rect;
      const mw = compact() ? Math.max(240, tw) : tw;
      // The menu's natural height: its chrome plus its rows (up to the
      // list's own limit). Zero until the first report.
      const m = menu(), l = list(), c = content();
      const natural = m && l && c ? m.rect.height - l.rect.height + Math.min(c.rect.height, LIST_MAX) : 0;
      const options = {
        anchor: a.rect,
        clip: a.clip,
        size: { width: mw, height: natural },
        side: props.side,
        align: props.align ?? "start",
        margin: MARGIN,
      };
      const p = place({ ...options, offset: GAP });
      return { ...p, left: p.x - a.rect.x, width: mw, height: th };
    });
    return (
      <Show when={at()}>
        {(g: Accessor<NonNullable<ReturnType<typeof at>>>) => (
          <div
            id={sub("menu")}
            ref={observeMenu}
            class="absolute z-30 flex flex-col gap-1 rounded-[10px] bg-chip p-1"
            style={`left: ${g().left}px; ${g().side === "top" ? "bottom" : "top"}: ${g().height + GAP}px; width: ${g().width}px; max-height: ${g().maxHeight}px`}
          >
            <Show when={props.search}>
              <div class="grid shrink-0">
                <input
                  id={sub("search")}
                  aria-label="Search"
                  value={query()}
                  onInput={(event) => search(event.value ?? "")}
                  class="col-start-1 row-start-1 h-7 w-full rounded-md border-0 bg-well px-2 pl-7 font-ui text-[13px] text-ink outline-none"
                />
                <Icon d={icons.search} class="pointer-events-none col-start-1 row-start-1 ml-2 size-3.5 self-center text-ink-4" />
                <Show when={query() === ""}>
                  <span class="pointer-events-none col-start-1 row-start-1 self-center pl-7 text-[13px] leading-4 text-ink-4">
                    {props.searchPlaceholder ?? "Search"}
                  </span>
                </Show>
              </div>
            </Show>
            <SelectOptions {...props} observeList={observeList} observeContent={observeContent} />
          </div>
        )}
      </Show>
    );
  }


function SelectOptions(props: SelectProps & { state: ReturnType<typeof createSelectState>; observeList: (node: NativeNode) => void; observeContent: (node: NativeNode) => void }): JSX.Element {
  const { rows, active, value, pick, sub } = props.state;
  return (
            <div role="listbox" ref={props.observeList} class="flex max-h-[264px] min-h-0 flex-col overflow-y-auto overscroll-contain">
              <div ref={props.observeContent} class="flex shrink-0 flex-col">
                <For each={rows()}>
                  {(row) =>
                    row.kind === "group" ? (
                      <div class="flex h-7 shrink-0 items-end px-2 pb-1 text-[11px] leading-4 font-medium text-ink-4">{row.label}</div>
                    ) : (
                      <div
                        role="option"
                        id={sub(`option-${row.index}`)}
                        aria-selected={row.option.value === value()}
                        aria-disabled={row.option.disabled ? true : undefined}
                        data-active={active() === row.index ? "" : undefined}
                        onClick={() => pick(row.option)}
                        class={`flex h-7 shrink-0 items-center gap-2 rounded-md px-2 aria-disabled:text-ink-6 not-aria-disabled:hover:bg-lift data-active:bg-lift ${
                          row.option.value === value() ? "text-ink" : "text-ink-body"
                        }`}
                      >
                        <span class={`min-w-0 flex-1 truncate ${props.mono ? "font-data text-[11px] leading-4" : "text-[13px] leading-4"}`}>
                          {row.option.label}
                        </span>
                        <Show when={row.option.detail}>
                          <span class="shrink-0 font-data text-[11px] leading-4 text-ink-4">{row.option.detail}</span>
                        </Show>
                        <span class="flex size-3.5 shrink-0 items-center justify-center">
                          <Show when={row.option.value === value()}>
                            <Icon d={icons.check} strokeWidth={2} class="size-3.5 text-ink" />
                          </Show>
                        </span>
                      </div>
                    )
                  }
                </For>
                <Show when={rows().length === 0}>
                  <div class="flex h-7 items-center px-2 text-[13px] leading-4 text-ink-4">No matches</div>
                </Show>
              </div>
            </div>
  );
}
