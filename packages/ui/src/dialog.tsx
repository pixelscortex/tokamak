/*
  <Dialog>
    <DialogTrigger>Rename</DialogTrigger>
    <DialogBackdrop />
    <DialogContent>
      <DialogTitle>Rename thread</DialogTitle>
      <DialogDescription>Only you see the new name.</DialogDescription>
      <div class="flex justify-end gap-2">
        <DialogClose>Cancel</DialogClose>
        <DialogClose variant="primary" onClick={save}>Save</DialogClose>
      </div>
    </DialogContent>
  </Dialog>

  ui-sdk Dialog with Tokamak looks: a stage panel, radius 16, padding 24, at
  most 440 wide, over a dimmed window. Trigger and Close take the Button
  look props.
  Slots: dialog-trigger, dialog-backdrop, dialog-content, dialog-title
  (16/26 600), dialog-description (14/20 secondary), dialog-close.
*/
import { DialogClose as UiDialogClose, DialogTrigger as UiDialogTrigger } from "@ui-sdk/solid/dialog";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { LookContent, lookAttributes, lookKeys, type ButtonLook } from "./button.tsx";

export { Dialog, DialogBackdrop, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/solid/dialog";

export type DialogTriggerProps = Omit<ComponentProps<typeof UiDialogTrigger>, "children"> & ButtonLook;

export function DialogTrigger(props: DialogTriggerProps): JSX.Element {
  const rest = omit(props, ...lookKeys);
  return (
    <UiDialogTrigger {...rest} {...lookAttributes(props)}>
      <LookContent {...props} />
    </UiDialogTrigger>
  );
}

export type DialogCloseProps = Omit<ComponentProps<typeof UiDialogClose>, "children"> & ButtonLook;

export function DialogClose(props: DialogCloseProps): JSX.Element {
  const rest = omit(props, ...lookKeys);
  return (
    <UiDialogClose {...rest} {...lookAttributes(props)}>
      <LookContent {...props} />
    </UiDialogClose>
  );
}
