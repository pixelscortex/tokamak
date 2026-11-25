import { For } from "solid-js";
import { Button, Input, Switch, icons } from "@tokamak/ui";
import type { JSX } from "@solidjs/web";
import { Caption, Section } from "./frame.tsx";

const switches = [
  { state: "on", checked: true },
  { state: "off", checked: false },
  { state: "focus", checked: true, preview: "focus" },
  { state: "disabled on", checked: true, disabled: true },
  { state: "disabled off", checked: false, disabled: true },
] as const;

export function Inputs(props: { theme: string }): JSX.Element {
  return (
    <Section label="Primitives · Input, Switch" title="One line, on or off">
      <div class="grid grid-cols-2 items-start gap-4">
        <Input aria-label={`Empty label, ${props.theme}`} placeholder="Personal" />
        <Input aria-label={`Filled label, ${props.theme}`} value="Personal" size="lg" />
        <Input
          aria-label={`Callback link, ${props.theme}`}
          mono
          placeholder="http://localhost:1455/callback?code=…"
        />
        <Input
          aria-label={`Search, ${props.theme}`}
          icon={icons.search}
          placeholder="Search subscriptions"
          trail={<Button variant="ghost" icon={icons.close} label="Clear" tabindex={-1} />}
        />
        <Input aria-label={`Focused, ${props.theme}`} data-preview="focus" placeholder="Focused" />
        <Input aria-label={`Invalid code, ${props.theme}`} mono invalid value="PERSONAL" />
        <Input aria-label={`Disabled, ${props.theme}`} disabled placeholder="Disabled" />
      </div>
      <Caption>md 40 · lg 48 · mono for links and codes · invalid edges in red.</Caption>
      <div class="flex items-center gap-6">
        <For each={switches}>
          {(item) => (
            <span class="flex items-center gap-2">
              <Switch
                aria-label={`${item.state}, ${props.theme}`}
                defaultChecked={item.checked}
                disabled={"disabled" in item}
                data-preview={"preview" in item ? item.preview : undefined}
                tabindex={item.state === "on" ? 0 : -1}
              />
              <Caption>{item.state}</Caption>
            </span>
          )}
        </For>
      </div>
    </Section>
  );
}
