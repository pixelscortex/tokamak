/*
  <Switch aria-label="Enabled" checked={enabled()} onCheckedChange={setEnabled} />
  <Switch aria-label="Enabled" defaultChecked />

  A 28 × 16 pill with a 12 px thumb, 2 px in (Paper "Flow · Profiles", the
  subscription card's "Enabled" toggle). On: an ink track with a stage thumb
  at the end. Off: the translucent edge-strong track, thumb at the start.
  Name it with aria-label or a <label>; it has no text of its own.
*/
import { Switch as Base, SwitchThumb } from "@ui-sdk/solid/switch";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { cn } from "./cn.ts";

export type SwitchProps = Omit<ComponentProps<typeof Base>, "class" | "children"> & { class?: string };

type KeyHandler = JSX.EventHandlerUnion<HTMLButtonElement, KeyboardEvent>;

function callKeyHandler(handler: KeyHandler | undefined, event: KeyboardEvent) {
  if (typeof handler === "function") (handler as (event: KeyboardEvent) => void)(event);
  else if (Array.isArray(handler))
    (handler[0] as (data: unknown, event: KeyboardEvent) => void)(handler[1], event);
}

export function Switch(props: SwitchProps): JSX.Element {
  const rest = omit(props, "class", "onKeyDown");
  // ui-sdk follows the ARIA switch pattern, where Enter submits the form and only
  // Space toggles. Tokamak's switches also toggle on Enter, like its buttons. Our
  // handler runs before ui-sdk's and preventDefault skips it, so Enter never also
  // submits; the click goes through ui-sdk's press, which honours readOnly.
  const keyDown = (event: KeyboardEvent & { currentTarget: HTMLButtonElement }) => {
    callKeyHandler(props.onKeyDown as KeyHandler | undefined, event);
    if (event.defaultPrevented || event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (!event.repeat) event.currentTarget.click();
  };
  return (
    <Base
      {...rest}
      onKeyDown={keyDown}
      class={cn(
        // 28 × 16 with a 2 px inset is off the 4 px scale: a w-6 h-3 content box inside
        // a 2 px transparent border gives it, and the fill shows through the border.
        "relative box-content inline-flex h-3 w-6 shrink-0 cursor-pointer items-center",
        "rounded-full border-2 border-transparent bg-edge-strong transition-colors duration-150 focus-ring",
        "data-checked:bg-ink",
        "data-disabled:cursor-default data-disabled:opacity-50",
        // Rules 09: every click target is 32 × 32 or bigger, so the hit area reaches past the pill.
        "after:absolute after:-inset-x-1 after:-inset-y-2",
        "motion-reduce:transition-none",
        props.class,
      )}
    >
      <SwitchThumb
        class={cn(
          "block size-3 rounded-full bg-stage transition-transform duration-150",
          "data-checked:translate-x-3 motion-reduce:transition-none",
        )}
      />
    </Base>
  );
}
