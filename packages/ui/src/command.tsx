/*
  <Command.Root onAction={run}>
    <Command.Search label="Search views and commands" placeholder="Search" />
    <Command.Empty>Nothing matches.</Command.Empty>
    <Command.List>
      <Command.Group>
        <Command.GroupLabel>Views</Command.GroupLabel>
        <Command.Item value="notes" icon={notesIcon}>Notes</Command.Item>
      </Command.Group>
    </Command.List>
  </Command.Root>

  A search row over a list of 32 rows with radius 8. Put it in a
  Dialog.Content with p-1 and rounded-md for a palette. Keys go in the
  item's children as a Kbd; they show, they are not bound here.
*/
import * as Base from "@ui-sdk/solid/command";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { cn } from "./cn.ts";
import { Icon } from "./icon.tsx";
import { icons } from "./icons.ts";
import { itemClass } from "./menu.tsx";

type Classed<T extends (props: any) => JSX.Element> = Omit<ComponentProps<T>, "class"> & { class?: string };

export function Root(props: Classed<typeof Base.Command>) {
  return <Base.Command {...omit(props, "class")} class={cn("flex min-h-0 flex-col", props.class)} />;
}

export function Search(
  props: Omit<ComponentProps<typeof Base.CommandInput>, "class" | "aria-label"> & {
    label: string;
    class?: string;
  },
) {
  return (
    <div class={cn("flex h-12 shrink-0 items-center gap-2 px-3 text-ink-3", props.class)}>
      <Icon path={icons.search} />
      <Base.CommandInput
        {...omit(props, "class", "label")}
        aria-label={props.label}
        class="h-full min-w-0 flex-1 border-0 bg-transparent text-row text-ink outline-none placeholder:text-ink-3"
      />
    </div>
  );
}

export function List(props: Classed<typeof Base.CommandList>) {
  return (
    <Base.CommandList
      {...omit(props, "class")}
      class={cn("flex min-h-0 flex-col gap-1 overflow-y-auto empty:hidden", props.class)}
    />
  );
}

export function Empty(props: Classed<typeof Base.CommandEmpty>) {
  return (
    <Base.CommandEmpty
      {...omit(props, "class")}
      class={cn("hidden px-3 pt-2 pb-4 text-row text-ink-3 data-empty:block", props.class)}
    />
  );
}

export const Group = Base.CommandGroup;

export function GroupLabel(props: Classed<typeof Base.CommandGroupLabel>) {
  return (
    <Base.CommandGroupLabel
      {...omit(props, "class")}
      class={cn("flex h-8 items-center px-2 text-label text-ink-3", props.class)}
    />
  );
}

export function Item(props: Classed<typeof Base.CommandItem> & { icon?: string }) {
  return (
    <Base.CommandItem
      {...omit(props, "class", "icon", "children")}
      class={cn(
        itemClass,
        "cursor-pointer data-pending:cursor-progress *:data-[slot=kbd]:ms-auto *:data-[slot=kbd]:ps-4",
        props.class,
      )}
    >
      {props.icon && <Icon path={props.icon} class="text-ink-3" />}
      {props.children}
    </Base.CommandItem>
  );
}

export function Separator(props: Classed<typeof Base.CommandSeparator>) {
  return (
    <Base.CommandSeparator
      {...omit(props, "class")}
      class={cn("-mx-1 my-1 h-px border-0 bg-edge", props.class)}
    />
  );
}
