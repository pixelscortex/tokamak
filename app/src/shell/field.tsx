import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon, cn } from "@tokamak/ui";

/**
 * A 48 px one-line field: a translucent well with an edge, a 16 px lead, the input
 * and an optional trail. The ring shows on the well, not the bare input.
 */
export function Field(props: {
  label: string;
  /** Shown above the field; without it the label is the input's accessible name only. */
  visibleLabel?: boolean;
  icon?: string;
  lead?: JSX.Element;
  trail?: JSX.Element;
  value: string;
  onInput: (value: string) => void;
  mono?: boolean;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
  autofocus?: boolean;
  autocomplete?: string;
  id?: string;
  name?: string;
  type?: "text" | "email" | "password";
  required?: boolean;
}): JSX.Element {
  const input = (
    <div class="flex h-12 items-center gap-3 rounded-md bg-edge/50 ps-4 pe-2 inset-ring inset-ring-edge focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-text">
      <Show when={props.icon}>{(path) => <Icon path={path()} class="text-ink-3" />}</Show>
      {props.lead}
      <input
        id={props.id}
        name={props.name}
        type={props.type ?? "text"}
        required={props.required}
        aria-label={props.visibleLabel ? undefined : props.label}
        aria-invalid={props.invalid ? "true" : undefined}
        aria-describedby={props.describedBy}
        autofocus={props.autofocus}
        autocomplete={props.autocomplete ?? "off"}
        spellcheck={false}
        placeholder={props.placeholder}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        class={cn(
          "h-full min-w-0 flex-1 bg-transparent text-row text-ink outline-none placeholder:text-ink-3",
          props.mono && "font-mono",
        )}
      />
      {props.trail}
    </div>
  );
  return (
    <Show when={props.visibleLabel} fallback={input}>
      <div class="flex flex-col gap-2">
        <label for={props.id} class="text-label text-ink-3">
          {props.label}
        </label>
        {input}
      </div>
    </Show>
  );
}
