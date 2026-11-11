/** Select: a trigger button that shows the current value, and a menu of
 * options in a `Sheet` (a raised plate of its own) that opens below or
 * above it.
 *
 *   <Select id="model" size="compact" side="top" mono
 *     options={[{ value: "openrouter/free", label: "openrouter/free", group: "OpenRouter" }]}
 *     value={model()} onValueChange={setModel} />
 *
 * - Options may carry a `group` (a heading, in order of first appearance),
 *   `detail` (dim text on the right) and `disabled`. The selected option
 *   has a check.
 * - `search` adds a field at the top of the menu that filters by label and
 *   detail. Blitz gives scripts no way to move focus, so the field is not
 *   focused when the menu opens: typing on the focused trigger goes into
 *   it, and a click puts the caret in it.
 * - Sizes: `field` (34 px, a form row) and `compact` (26 px, toolbars and
 *   the composer: no plate until hover).
 * - Keyboard: on the trigger, Down or Up opens; Enter or Space toggles.
 *   While open, Up and Down move over the enabled options, Enter picks,
 *   Escape closes, Tab closes and moves on. A click outside closes it (the
 *   shell's root reports clicks; see dismiss.ts).
 * - The menu is a separate sheet with a 4 px gap, no fused bridge.
 *
 * Ids: the trigger has `id`; the menu `${id}-menu`, the search field
 * `${id}-search`, each option `${id}-option-${index}` (index in `options`). */
import { For, Show, createMemo, createSignal, untrack } from "solid-js";
import type { JSX, NativeEvent, NativeNode } from "@tokamak/render";
import { Icon } from "../elements/icon";
import { dismissable } from "./dismiss";
import { icons } from "./icons";
import { Sheet } from "./surface";

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
  /** Where the menu opens (default `bottom`). */
  side?: "bottom" | "top";
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
        class={`flex min-w-0 items-center gap-1.5 border-0 font-ui outline-none focus:ring-2 focus:ring-ink-5 aria-disabled:opacity-40 ${
          compact()
            ? "h-[26px] rounded-sm bg-transparent px-2 text-ink-3 not-aria-disabled:hover:bg-chip not-aria-disabled:hover:text-ink aria-expanded:bg-chip aria-expanded:text-ink"
            : "h-[34px] w-full justify-between rounded-md bg-chip elevation-3 px-3 text-ink not-aria-disabled:hover:sink-1 not-aria-disabled:active:pressed"
        }`}
      >
        <span class={`min-w-0 truncate ${type()} ${selected() ? "" : "text-ink-4"}`}>
          {selected()?.label ?? props.placeholder ?? ""}
        </span>
        <Icon d={icons.chevronDown} strokeWidth={2} class={`shrink-0 text-ink-4 ${compact() ? "size-3" : "size-3.5"}`} />
      </button>
      <Show when={open()}>
        {(() => {
          layer = dismissable(() => setOpen(false));
          return (
            <Sheet
              id={props.id ? `${props.id}-menu` : undefined}
              class={`material-card absolute z-30 flex max-w-[320px] min-w-full flex-col gap-1 rounded-lg p-1 ${
                props.side === "top" ? "bottom-full mb-1" : "top-full mt-1"
              } ${props.align === "end" ? "right-0" : "left-0"} ${compact() ? "w-[240px]" : "w-full"}`}
            >
              <Show when={props.search}>
                <div class="grid">
                  <input
                    id={props.id ? `${props.id}-search` : undefined}
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
              <div role="listbox" class="flex max-h-[264px] flex-col overflow-y-auto">
                <For each={rows()}>
                  {(row) =>
                    row.kind === "group" ? (
                      <div class="flex h-7 shrink-0 items-end px-2 pb-1 text-[11px] leading-4 font-medium text-ink-4">{row.label}</div>
                    ) : (
                      <div
                        role="option"
                        id={props.id ? `${props.id}-option-${row.index}` : undefined}
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
            </Sheet>
          );
        })()}
      </Show>
    </div>
  );
}
