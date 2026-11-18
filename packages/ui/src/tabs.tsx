/*
  <Tabs.Root defaultValue="changes">
    <Tabs.List aria-label="Review">
      <Tabs.Tab value="files">Files</Tabs.Tab>
      <Tabs.Tab value="changes">Changes <span class="text-data text-ink-3">4</span></Tabs.Tab>
    </Tabs.List>
    <Tabs.Panel value="files">…</Tabs.Panel>
  </Tabs.Root>

  Tabs are 32 tall, label weight, secondary at rest; the selected tab takes
  the selected fill and ink. No underline, no colour.
*/
import * as Base from "@ui-sdk/solid/tabs";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { cn } from "./cn.ts";

type Classed<T extends (props: any) => JSX.Element> = Omit<ComponentProps<T>, "class"> & { class?: string };

export function Root(props: Classed<typeof Base.Tabs>) {
  return <Base.Tabs {...omit(props, "class")} class={cn("flex flex-col", props.class)} />;
}

export function List(props: Classed<typeof Base.TabsList>) {
  return <Base.TabsList {...omit(props, "class")} class={cn("flex items-center gap-1", props.class)} />;
}

export function Tab(props: Classed<typeof Base.TabsTab>) {
  return (
    <Base.TabsTab
      {...omit(props, "class")}
      class={cn(
        "inline-flex h-8 cursor-pointer items-center gap-2 rounded-sm px-3 text-label whitespace-nowrap text-ink-2",
        "focus-ring hover:bg-hover data-selected:bg-selected data-selected:text-ink",
        "data-disabled:cursor-default data-disabled:text-ink-3 data-disabled:hover:bg-transparent",
        props.class,
      )}
    />
  );
}

export function Panel(props: Classed<typeof Base.TabsPanel>) {
  return <Base.TabsPanel {...omit(props, "class")} class={cn("rounded-sm focus-ring", props.class)} />;
}
