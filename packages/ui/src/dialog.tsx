/*
  <Dialog.Root>
    <Dialog.Trigger>Rename</Dialog.Trigger>
    <Dialog.Backdrop />
    <Dialog.Content>
      <Dialog.Title>Rename thread</Dialog.Title>
      <Dialog.Description>Only you see the new name.</Dialog.Description>
      <div class="flex justify-end gap-2">
        <Dialog.Close>Cancel</Dialog.Close>
        <Dialog.Close variant="brand">Save</Dialog.Close>
      </div>
    </Dialog.Content>
  </Dialog.Root>

  A stage panel, radius 16, padding 24, at most 440 wide, over a dimmed
  window. Trigger and Close take the Button look props.
*/
import * as Base from "@ui-sdk/solid/dialog";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { ButtonContent, buttonClass, lookKeys, type ButtonLook } from "./button.tsx";
import { cn } from "./cn.ts";

type Classed<T extends (props: any) => JSX.Element> = Omit<ComponentProps<T>, "class"> & { class?: string };

export const Root = Base.Dialog;

export function Trigger(
  props: Omit<ComponentProps<typeof Base.DialogTrigger>, "children" | "class"> & ButtonLook,
) {
  const rest = omit(props, ...lookKeys);
  return (
    <Base.DialogTrigger {...rest} class={buttonClass(props)} aria-label={props.label}>
      <ButtonContent {...props} />
    </Base.DialogTrigger>
  );
}

export function Close(
  props: Omit<ComponentProps<typeof Base.DialogClose>, "children" | "class"> & ButtonLook,
) {
  const rest = omit(props, ...lookKeys);
  return (
    <Base.DialogClose {...rest} class={buttonClass(props)} aria-label={props.label}>
      <ButtonContent {...props} />
    </Base.DialogClose>
  );
}

export function Backdrop(props: Classed<typeof Base.DialogBackdrop>) {
  return (
    <Base.DialogBackdrop
      {...omit(props, "class")}
      class={cn(
        "fixed inset-0 bg-window/70 transition duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0",
        props.class,
      )}
    />
  );
}

export function Content(props: Classed<typeof Base.DialogContent>) {
  return (
    <Base.DialogContent
      {...omit(props, "class")}
      class={cn(
        "m-auto flex max-h-dvh w-full max-w-dialog flex-col gap-2 overflow-auto rounded-lg border-0",
        "surface-stage p-6 inset-ring inset-ring-edge backdrop:bg-window/70",
        "transition duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0",
        props.class,
      )}
    />
  );
}

export function Title(props: Classed<typeof Base.DialogTitle>) {
  return (
    <Base.DialogTitle
      {...omit(props, "class")}
      class={cn("m-0 text-read font-semibold text-ink", props.class)}
    />
  );
}

export function Description(props: Classed<typeof Base.DialogDescription>) {
  return (
    <Base.DialogDescription
      {...omit(props, "class")}
      class={cn("m-0 mb-4 text-row text-ink-2", props.class)}
    />
  );
}
