/*
  <Input aria-label="Label" placeholder="Personal" size="lg" />
  <Input aria-label="Callback link" mono placeholder="http://localhost:1455/callback?code=…" />
  <Input aria-label="Search" icon={icons.search} trail={<Button variant="ghost" icon={icons.close} label="Clear" />} />

  One line of text in the Textarea's translucent well and edge, radius 12
  (Paper "Flow · Profiles", the add-subscription dialog). md is 40 tall with
  12 px sides, as the pasted-link field; lg is 48 with 16, as the label
  field, for roomy forms. mono sets the text in data mono for links and codes.
  icon puts a 16 px tertiary mark before the text; trail holds one action,
  such as a ghost icon button, at the end. invalid edges it in red; say why in
  words beside it, never by colour alone, and point aria-describedby at those words.
*/
import { Input as Base, InputGroup } from "@ui-sdk/solid/input";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { tv } from "./cn.ts";
import { Icon } from "./icon.tsx";

export const inputVariants = tv({
  slots: {
    root: [
      "flex min-w-0 cursor-text items-center gap-2 rounded-md bg-edge/50 text-ink inset-ring inset-ring-edge",
      // The ring sits on the well, not the <input>, so it wraps the icon and the action too.
      // focus-ring also draws it for the kit's data-preview="focus".
      "focus-ring has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand-text",
      "has-aria-invalid:inset-ring-removed",
      "data-disabled:cursor-default data-disabled:opacity-50",
    ],
    control: [
      "h-full min-w-0 flex-1 truncate bg-transparent outline-hidden placeholder:text-ink-3",
      "disabled:cursor-default",
    ],
  },
  variants: {
    size: {
      md: { root: "h-10 px-3" },
      lg: { root: "h-12 px-4" },
    },
    mono: { true: { control: "text-data" }, false: { control: "text-row" } },
    // An action fills the end: 4 px in on md keeps a 32 px button concentric with the
    // 12 px corner (12 − 4 = its 8); lg centres it in the 48 px row.
    trail: { true: {} },
  },
  compoundVariants: [
    { trail: true, size: "md", class: { root: "pe-1" } },
    { trail: true, size: "lg", class: { root: "pe-2" } },
  ],
  defaultVariants: { size: "md", mono: false },
});

export type InputProps = Omit<ComponentProps<typeof Base>, "class" | "size"> & {
  size?: "md" | "lg";
  /** Data mono (12 / 16) for links, codes and anything a person would copy. */
  mono?: boolean;
  /** A 16 px icon path before the text. */
  icon?: string;
  /** One action at the end, such as a ghost icon button. */
  trail?: JSX.Element;
  /** Marks the value wrong: aria-invalid on the field and a red edge. */
  invalid?: boolean;
  /** Layout classes for the well (width, margin, flex placement). */
  class?: string;
  /** Pins a state on the well for the kit page (focus); see theme.css. */
  "data-preview"?: string;
};

export function Input(props: InputProps): JSX.Element {
  const rest = omit(props, "class", "size", "mono", "icon", "trail", "invalid", "data-preview");
  // `trail={value() && <Clear />}` passes false or "" when there is nothing to show; only a
  // real action may take the end padding.
  const hasTrail = () =>
    props.trail !== undefined && props.trail !== null && props.trail !== false && props.trail !== "";
  const styles = () => inputVariants({ size: props.size, mono: props.mono, trail: hasTrail() });
  return (
    <InputGroup data-preview={props["data-preview"]} class={styles().root({ class: props.class })}>
      {props.icon && <Icon path={props.icon} class="text-ink-3" />}
      <Base
        {...rest}
        aria-invalid={props.invalid ? "true" : props["aria-invalid"]}
        class={styles().control()}
      />
      {props.trail}
    </InputGroup>
  );
}
