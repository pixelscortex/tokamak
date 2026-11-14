/** A trigger and menu fused while open. Field and compact sizes; placement
 * follows available space above/below the trigger and updates with layout.
 *
 * <Select options={models} value={model()} onValueChange={setModel} search />
 *
 * Arrow keys open/navigate; Enter picks; Escape and Tab close. Typing on the
 * focused trigger filters a searchable menu because Blitz cannot focus it
 * programmatically. Shell dismisses clicks outside the menu.
 */
import { For, Show, createMemo, createSignal, untrack } from "solid-js";
import type { Accessor } from "solid-js";
import type { JSX, NativeEvent, NativeNode } from "@tokamak/render";
import { Icon } from "../elements/icon";
import { dismissable } from "./dismiss";
import { place, trackLayout } from "./floating";
import { icons } from "./icons";
import { Surface } from "./surface";

/** Gap between the trigger and its menu, bridged. */
const GAP = 6;
/** Concave fillets where plates meet. */
const JOIN = 3;
/** Narrower than this, no bridge: the menu merges onto the trigger. */
const MIN_BRIDGE = 64;
/** Kept free between the menu and the edge of its clipping area. */
const MARGIN = 8;
/** The list's own height limit (the menu may get less room). */
const LIST_MAX = 264;

export interface SelectOption {
  value: string;
  label: string;
  /** Dim secondary text on the right (a price, a context size). */
  detail?: string;
  /** Group heading this option sits under. */
  group?: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: readonly SelectOption[];
  value?: string;
  /** Uncontrolled initial value (read once). */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Shown on the trigger while nothing is selected. */
  placeholder?: string;
  /** `field` (34 px, default) or `compact` (26 px). */
  size?: "field" | "compact";
  /** Where the menu prefers to open (default `bottom`; `auto` is
   * `bottom`). It flips when that side lacks room and the other has more. */
  side?: "bottom" | "top" | "auto";
  /** Which edge of the trigger the menu lines up with (default `start`). */
  align?: "start" | "end";
  /** Show a search field at the top of the menu. */
  search?: boolean;
  searchPlaceholder?: string;
  /** Values and options in the data font (model names, ids). */
  mono?: boolean;
  disabled?: boolean;
  /** Open when first shown (an open example in a gallery). */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  id?: string;
  /** Accessible name of the trigger. */
  label?: string;
  /** Classes of the outer element (width, margins). */
  class?: string;
}

/** The open menu's geometry, CSS px relative to the trigger's box. */
interface Geometry {
  side: "top" | "bottom";
  /** No bridge: the menu sits on the trigger. */
  merged: boolean;
  /** The fused surface's left edge and width. */
  left: number;
  width: number;
  /** Trigger, menu and bridge: left edge (in the surface) and size. */
  tx: number;
  tw: number;
  th: number;
  mx: number;
  mw: number;
  bx: number;
  bw: number;
  /** The room on the menu's side. */
  maxHeight: number;
}

type Row =
  | { kind: "group"; label: string }
  | { kind: "option"; option: SelectOption; index: number };

export function Select(props: SelectProps): JSX.Element {
  const [own, setOwn] = createSignal(untrack(() => props.defaultValue));
  const [open, setOpenSignal] = createSignal(untrack(() => props.defaultOpen ?? false));
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal<number>();
  const value = () => props.value ?? own();
  const selected = () => props.options.find((o) => o.value === value());
  let trigger: NativeNode | undefined;
  let layer: { mark(): void } | undefined;

  /** Options that match the search, grouped, with their index in `options`. */
  const rows = createMemo<Row[]>(() => {
    const q = query().trim().toLowerCase();
    const matches = props.options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !q || `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(q));
    const groups: string[] = [];
    for (const { option } of matches) {
      const g = option.group ?? "";
      if (!groups.includes(g)) groups.push(g);
    }
    const out: Row[] = [];
    for (const g of groups) {
      if (g) out.push({ kind: "group", label: g });
      for (const m of matches) if ((m.option.group ?? "") === g) out.push({ kind: "option", ...m });
    }
    return out;
  });
  /** Enabled options in display order: what Up and Down move over. */
  const order = () =>
    rows().flatMap((r) => (r.kind === "option" && !r.option.disabled ? [r.index] : []));

  /** The row Up and Down start from: the selected option, else the first. */
  function reset() {
    setQuery("");
    const at = props.options.findIndex((o) => o.value === value() && !o.disabled);
    setActive(at >= 0 ? at : order()[0]);
  }
  if (untrack(open)) reset();
  function setOpen(next: boolean) {
    if (next === open() || (next && props.disabled)) return;
    setOpenSignal(next);
    if (next) reset();
    props.onOpenChange?.(next);
  }
  function pick(option: SelectOption) {
    if (option.disabled) return;
    if (props.value === undefined) setOwn(option.value);
    props.onValueChange?.(option.value);
    setOpen(false);
  }
  function move(step: 1 | -1) {
    const list = order();
    if (!list.length) return setActive(undefined);
    const at = list.indexOf(active() ?? -1);
    setActive(list[at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length]);
  }
  function keydown(event: NativeEvent) {
    if (event.defaultPrevented || event.isComposing || props.disabled) return;
    const key = event.key;
    if (!open()) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      move(key === "ArrowDown" ? 1 : -1);
    } else if (key === "Enter") {
      // Also keeps the focused trigger from toggling the menu again.
      event.preventDefault();
      const option = props.options[active() ?? -1];
      if (option) pick(option);
    } else if (key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (key === "Tab") {
      setOpen(false);
    } else if (props.search && trigger && event.target === trigger.id && !event.metaKey && !event.ctrlKey) {
      // Typing on the trigger goes into the search field.
      if (key === "Backspace") {
        event.preventDefault();
        search(query().slice(0, -1));
      } else if (key && key.length === 1 && key !== " ") {
        event.preventDefault();
        search(query() + key);
      }
    }
  }
  function search(next: string) {
    setQuery(next);
    setActive(order()[0]);
  }

  const compact = () => props.size === "compact";
  const type = () => (props.mono ? "font-data text-[11px] leading-4" : compact() ? "text-[12px] leading-4" : "text-[13px] leading-4");
  const sub = (part: string) => (props.id ? `${props.id}-${part}` : undefined);

  /** The open menu: trigger, bridge and menu as one fused surface. */
  function Menu() {
    layer = dismissable(() => setOpen(false));
    const [anchor, observeAnchor] = trackLayout();
    const [menu, observeMenu] = trackLayout();
    const [list, observeList] = trackLayout();
    const [content, observeContent] = trackLayout();
    if (trigger) observeAnchor(trigger);
    /** Everything in CSS px relative to the trigger's box. */
    const at = createMemo((): Geometry | undefined => {
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
      const bridged = place({ ...options, offset: GAP });
      const mx = bridged.x - a.rect.x;
      // Where trigger and menu overlap: 80% of it is the bridge.
      const lo = Math.max(0, mx);
      const span = Math.max(0, Math.min(tw, mx + mw) - lo);
      const merged = span * 0.8 < MIN_BRIDGE;
      const p = merged ? place({ ...options, offset: 0 }) : bridged;
      const left = Math.min(0, mx);
      return {
        side: p.side,
        merged,
        left,
        width: Math.max(tw, mx + mw) - left,
        tx: -left,
        tw,
        th,
        mx: mx - left,
        mw,
        bx: lo + span * 0.1 - left,
        bw: span * 0.8,
        maxHeight: p.maxHeight,
      };
    });
    return (
      <Show when={at()}>
        {(g: Accessor<Geometry>) => (
          <Surface
            id={sub("fused")}
            own={false}
            join={JOIN}
            class={`surface-chip bevel-1 pointer-events-none absolute z-30 flex items-start ${g().side === "top" ? "flex-col-reverse" : "flex-col"}`}
            style={`left: ${g().left}px; ${g().side === "top" ? "bottom" : "top"}: 0; width: ${g().width}px`}
          >
            {/* The trigger's face: the real button sits above it (z-31). */}
            <Surface.Add
              id={sub("face")}
              attach={g().merged ? (g().side === "top" ? "top" : "bottom") : undefined}
              class={compact() ? "shrink-0 rounded-sm" : "shrink-0 rounded-md"}
              style={`margin-left: ${g().tx}px; width: ${g().tw}px; height: ${g().th}px`}
            />
            <Show when={!g().merged}>
              <Surface.Add
                id={sub("bridge")}
                class="pointer-events-auto shrink-0"
                style={`margin-left: ${g().bx}px; width: ${g().bw}px; height: ${GAP}px`}
              />
            </Show>
            <Surface.Add
              id={sub("menu")}
              ref={observeMenu}
              class="pointer-events-auto flex shrink-0 flex-col gap-1 rounded-[10px] p-1"
              style={`margin-left: ${g().mx}px; width: ${g().mw}px; max-height: ${g().maxHeight}px`}
            >
              <Show when={props.search}>
                <div class="grid shrink-0">
                  <input
                    id={sub("search")}
                    aria-label="Search"
                    value={query()}
                    onInput={(event) => search(event.value ?? "")}
                    class="col-start-1 row-start-1 h-7 w-full rounded-md border-0 material-well px-2 pl-7 font-ui text-[13px] text-ink outline-none"
                  />
                  <Icon d={icons.search} class="pointer-events-none col-start-1 row-start-1 ml-2 size-3.5 self-center text-ink-4" />
                  <Show when={query() === ""}>
                    <span class="pointer-events-none col-start-1 row-start-1 self-center pl-7 text-[13px] leading-4 text-ink-4">
                      {props.searchPlaceholder ?? "Search"}
                    </span>
                  </Show>
                </div>
              </Show>
              <div role="listbox" ref={observeList} class="flex max-h-[264px] min-h-0 flex-col overflow-y-auto overscroll-contain">
                <div ref={observeContent} class="flex shrink-0 flex-col">
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
            </Surface.Add>
          </Surface>
        )}
      </Show>
    );
  }

  return (
    <div
      class={`relative flex ${props.class ?? ""}`}
      onKeyDown={keydown}
      onClick={() => layer?.mark()}
    >
      <button
        type="button"
        id={props.id}
        ref={(node) => (trigger = node)}
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-disabled={props.disabled ? true : undefined}
        disabled={props.disabled}
        onClick={() => setOpen(!open())}
        class={`relative flex min-w-0 items-center gap-1.5 border-0 font-ui outline-none focus:ring-2 focus:ring-ink-5 aria-disabled:opacity-40 aria-expanded:z-[31] ${
          compact()
            ? "h-[26px] rounded-sm bg-transparent px-2 text-ink-3 not-aria-disabled:hover:text-ink not-aria-disabled:not-aria-expanded:hover:bg-chip aria-expanded:text-ink"
            : "h-[34px] w-full justify-between rounded-md px-3 text-ink not-aria-expanded:bg-chip not-aria-disabled:not-aria-expanded:hover:bg-lift not-aria-disabled:not-aria-expanded:active:bg-card"
        }`}
      >
        <span class={`min-w-0 truncate ${type()} ${selected() ? "" : "text-ink-4"}`}>
          {selected()?.label ?? props.placeholder ?? ""}
        </span>
        <Icon d={icons.chevronDown} strokeWidth={2} class={`shrink-0 text-ink-4 ${compact() ? "size-3" : "size-3.5"}`} />
      </button>
      <Show when={open()}>
        <Menu />
      </Show>
    </div>
  );
}
