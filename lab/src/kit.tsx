/** Small lab pieces shared by the sections: icon buttons, sidebar list rows,
 * and section titles. */
import { Show } from "solid-js";
import type { JSX } from "@tokamak/render";
import { Icon } from "@tokamak/ui/elements";
import { Surface } from "@tokamak/ui/components";

/** 28 px square icon button (top bar, composer). */
export function IconButton(props: {
  d: string;
  label: string;
  id?: string;
  active?: boolean;
  dim?: boolean;
  onClick?: () => void;
}) {
  const icon = () => (
    <Icon
      d={props.d}
      class={`size-4 ${props.active ? "text-ink" : props.dim ? "text-ink-6" : "text-ink-3"}`}
    />
  );
  return (
    <Show
      when={props.active}
      fallback={
        <button
          id={props.id}
          aria-label={props.label}
          onClick={props.onClick}
          class="flex size-7 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0"
        >
          {icon()}
        </button>
      }
    >
      <Surface material="chip" radius={6} class="size-7 shrink-0">
        <button
          id={props.id}
          aria-label={props.label}
          onClick={props.onClick}
          class="flex size-7 items-center justify-center border-0 bg-transparent p-0"
        >
          {icon()}
        </button>
      </Surface>
    </Show>
  );
}

/** Sidebar header: section title and an optional trailing icon. */
export function SidebarHeader(props: { title: string; action?: string }) {
  return (
    <>
      <div class="flex h-8 shrink-0 items-center justify-between pr-1 pl-2">
        <span class="text-[14px] leading-5 font-semibold tracking-[-0.01em] text-ink">
          {props.title}
        </span>
        <Show when={props.action}>
          <IconButton d={props.action ?? ""} label="Filter" />
        </Show>
      </div>
      <div class="h-3 shrink-0" />
    </>
  );
}

export function SidebarLabel(props: { children: JSX.Element; first?: boolean }) {
  return (
    <>
      <Show when={!props.first}>
        <div class="h-4 shrink-0" />
      </Show>
      <div class="flex h-7 shrink-0 items-center px-2 text-[12px] leading-4 font-medium text-ink-4">
        {props.children}
      </div>
    </>
  );
}

/** One sidebar row; the selected row is a small chip surface. */
export function SidebarRow(props: {
  label: string;
  meta?: string;
  selected?: boolean;
  dot?: boolean;
  id?: string;
  onClick?: () => void;
}) {
  const content = () => (
    <>
      <span
        class={`min-w-0 flex-1 truncate text-[13px] leading-4 ${
          props.selected ? "font-medium text-ink" : "text-ink-2"
        }`}
      >
        {props.label}
      </span>
      <Show when={props.dot}>
        <span class="size-1.5 shrink-0 rounded-full bg-ink" />
      </Show>
      <Show when={props.meta}>
        <span class="font-data text-[11px] leading-4 text-ink-5">{props.meta}</span>
      </Show>
    </>
  );
  return (
    <Show
      when={props.selected}
      fallback={
        <div id={props.id} onClick={props.onClick} class="flex h-[30px] shrink-0 items-center gap-2.5 px-2">
          {content()}
        </div>
      }
    >
      <Surface
        id={props.id}
        material="chip"
        radius={6}
        class="flex h-[30px] shrink-0 items-center gap-2.5 px-2"
      >
        {content()}
      </Surface>
    </Show>
  );
}

/** A section heading inside the stage. */
export function SectionTitle(props: { eyebrow: string; title: string; children?: JSX.Element }) {
  return (
    <header class="flex flex-col gap-2">
      <p class="m-0 text-[11px] tracking-[0.08em] text-ink-4">{props.eyebrow}</p>
      <h2 class="m-0 text-[18px] font-medium text-ink">{props.title}</h2>
      <Show when={props.children}>
        <p class="m-0 max-w-[760px] text-[13px] leading-5 text-ink-3">{props.children}</p>
      </Show>
    </header>
  );
}
