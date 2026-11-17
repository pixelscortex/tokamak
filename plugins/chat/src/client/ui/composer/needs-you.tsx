import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Menu, StatusIcon, icons } from "@tokamak/ui";
import { permissionOptions, type Permission } from "../../lib/turns";

/**
 * A permission request: the one raised band in chat. Allow is the main
 * action; the first reject option sits beside it and any others are in a menu.
 */
export function NeedsYou(props: {
  part: Permission;
  agentName: string;
  busy: boolean;
  onAnswer: (optionId: string) => void;
}): JSX.Element {
  const options = () => permissionOptions(props.part);
  const allow = () => options().find((option) => option.kind.startsWith("allow"));
  const reject = () => options().find((option) => !option.kind.startsWith("allow"));
  const others = () => options().filter((option) => option !== allow() && option !== reject());
  return (
    <section
      aria-label={`${props.agentName} needs you`}
      class="flex items-center gap-2 rounded-inner bg-band py-1 ps-3 pe-1"
    >
      <StatusIcon status="needs-you" />
      <span class="min-w-0 flex-1 truncate text-row text-ink" title={props.part.title}>
        {props.part.title}
      </span>
      <Show when={others().length}>
        <Menu.Root onAction={(value) => props.onAnswer(String(value))}>
          <Menu.Trigger variant="ghost" icon={icons.more} label="More answers" disabled={props.busy} />
          <Menu.Content>
            <For each={others()}>
              {(option) => <Menu.Item value={option.optionId}>{option.name}</Menu.Item>}
            </For>
          </Menu.Content>
        </Menu.Root>
      </Show>
      <Show when={reject()}>
        {(option) => (
          <Button disabled={props.busy} onClick={() => props.onAnswer(option().optionId)}>
            {option().name}
          </Button>
        )}
      </Show>
      <Show when={allow()}>
        {(option) => (
          <Button variant="primary" disabled={props.busy} onClick={() => props.onAnswer(option().optionId)}>
            {option().name}
          </Button>
        )}
      </Show>
    </section>
  );
}
