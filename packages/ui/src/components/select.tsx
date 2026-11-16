/** A trigger and a separate menu. Field and compact sizes; placement
 * follows available space above/below the trigger and updates with layout.
 *
 * <Select options={models} value={model()} onValueChange={setModel} search />
 *
 * Arrow keys open/navigate; Enter picks; Escape and Tab close. Typing on the
 * focused trigger filters a searchable menu because Blitz cannot focus it
 * programmatically. Shell dismisses clicks outside the menu.
 */
import { Show, createMemo, createSignal, untrack } from "solid-js";
import type { JSX, NativeEvent, NativeNode } from "@tokamak/render";
import { Icon } from "../elements/icon";
import { SelectMenu } from "./select-menu";
import { icons } from "./icons";

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

type Row =
  | { kind: "group"; label: string }
  | { kind: "option"; option: SelectOption; index: number };

export function Select(props: SelectProps): JSX.Element {
  const state = createSelectState(props);
  const { selected, open, compact, type, setOpen, keydown } = state;

  return (
    <div
      class={`relative flex ${props.class ?? ""}`}
      onKeyDown={keydown}
      onClick={state.mark}
    >
      <button
        type="button"
        id={props.id}
        ref={state.setTrigger}
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-disabled={props.disabled ? true : undefined}
        disabled={props.disabled}
        onClick={() => setOpen(!open())}
        class={`relative flex min-w-0 items-center gap-1.5 border-0 font-ui outline-none focus:ring-2 focus:ring-ink-5 aria-disabled:opacity-40 aria-expanded:z-[31] ${
          compact()
            ? "h-[26px] rounded-sm bg-transparent px-2 text-ink-3 not-aria-disabled:hover:text-ink not-aria-disabled:not-aria-expanded:hover:bg-chip aria-expanded:text-ink aria-expanded:bg-chip"
            : "h-[34px] w-full justify-between rounded-md bg-chip px-3 text-ink not-aria-expanded:bg-chip not-aria-disabled:not-aria-expanded:hover:bg-lift not-aria-disabled:not-aria-expanded:active:bg-card"
        }`}
      >
        <span class={`min-w-0 truncate ${type()} ${selected() ? "" : "text-ink-4"}`}>
          {selected()?.label ?? props.placeholder ?? ""}
        </span>
        <Icon d={icons.chevronDown} strokeWidth={2} class={`shrink-0 text-ink-4 ${compact() ? "size-3" : "size-3.5"}`} />
      </button>
      <Show when={open()}>
        <SelectMenu {...props} state={state} />
      </Show>
    </div>
  );
}

export function createSelectState(props: SelectProps) {
  const [own, setOwn] = createSignal(untrack(() => props.defaultValue));
  const [open, setOpenSignal] = createSignal(untrack(() => props.defaultOpen ?? false));
  const { query, setQuery, active, setActive, rows, order, search } = createSelectSearch(props);
  const value = () => props.value ?? own();
  const selected = () => props.options.find((o) => o.value === value());
  let trigger: NativeNode | undefined;
  let layer: { mark(): void } | undefined;

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
    } else {
      typeSearch(event);
    }
  }
  function typeSearch(event: NativeEvent) {
    if (!props.search || !trigger || event.target !== trigger.id || event.metaKey || event.ctrlKey) return;
    const key = event.key;
    // Typing on the trigger goes into the search field.
    if (key === "Backspace") {
      event.preventDefault();
      search(query().slice(0, -1));
    } else if (key && key.length === 1 && key !== " ") {
      event.preventDefault();
      search(query() + key);
    }
  }

  const compact = () => props.size === "compact";
  const type = () => (props.mono ? "font-data text-[11px] leading-4" : compact() ? "text-[12px] leading-4" : "text-[13px] leading-4");
  const sub = (part: string) => (props.id ? `${props.id}-${part}` : undefined);

  return {
    value, selected, open, query, active, rows, compact, type, sub, setOpen, pick, search, keydown,
    trigger: () => trigger, setTrigger: (node: NativeNode) => { trigger = node; },
    setLayer: (next: { mark(): void }) => { layer = next; }, mark: () => layer?.mark(),
  };
}

function createSelectSearch(props: SelectProps) {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal<number>();
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

  function search(next: string) {
    setQuery(next);
    setActive(order()[0]);
  }

  return { query, setQuery, active, setActive, rows, order, search };
}
