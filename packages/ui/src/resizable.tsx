/*
  <Resizable.Root autoSaveId="frame">
    <Resizable.Panel id="stage" minSize="400px">…</Resizable.Panel>
    <Resizable.Handle aria-label="Resize panel" />
    <Resizable.Panel id="panel" defaultSize="600px" minSize="360px">…</Resizable.Panel>
  </Resizable.Root>

  Panels side by side with a draggable divider between them. The handle is
  the 4 px gap between two surfaces, a quiet line on hover and while dragged;
  its hit area is wider than it looks, and arrow keys move it when focused.
  autoSaveId keeps the sizes in this device's storage.
*/
import * as Base from "@ui-sdk/solid/resizable";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { cn } from "./cn.ts";

type Classed<T extends (props: any) => JSX.Element> = Omit<ComponentProps<T>, "class"> & { class?: string };

export function Root(props: Classed<typeof Base.Resizable>): JSX.Element {
  return <Base.Resizable {...omit(props, "class")} class={cn("flex min-h-0 min-w-0", props.class)} />;
}

export function Panel(props: Classed<typeof Base.ResizablePanel>): JSX.Element {
  return <Base.ResizablePanel {...omit(props, "class")} class={cn("flex min-h-0 min-w-0", props.class)} />;
}

export function Handle(props: Omit<Classed<typeof Base.ResizableHandle>, "children">): JSX.Element {
  return (
    <Base.ResizableHandle
      {...omit(props, "class")}
      class={cn(
        "group/handle relative flex w-1 shrink-0 cursor-col-resize justify-center focus-ring",
        props.class,
      )}
    >
      <span class="my-2 w-px rounded-full transition duration-200 group-data-hovering/handle:bg-edge-strong group-data-dragging/handle:bg-edge-strong" />
    </Base.ResizableHandle>
  );
}
