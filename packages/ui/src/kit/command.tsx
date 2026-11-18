import type { JSX } from "@solidjs/web";
import { Command, Kbd, Menu } from "@tokamak/ui";
import { Caption, Section } from "./frame.tsx";

export function CommandList(props: { theme: string }): JSX.Element {
  return (
    <Section label="Primitive · Command, Menu.RadioItem" title="Search and choices">
      <Caption>A search row over 32 rows; in the app it sits in a dialog opened with ⌘K.</Caption>
      <div class="flex items-start gap-8">
        <div class="w-full max-w-dialog rounded-md surface-card p-1 inset-ring inset-ring-edge">
          <Command.Root>
            <Command.Search label={`Search, ${props.theme}`} placeholder="Search views and commands" />
            <Command.Empty>Nothing matches.</Command.Empty>
            <Command.List>
              <Command.Group>
                <Command.GroupLabel>Views</Command.GroupLabel>
                <Command.Item value="chat">Chat</Command.Item>
                <Command.Item value="notes">Notes</Command.Item>
              </Command.Group>
              <Command.Separator />
              <Command.Group>
                <Command.GroupLabel>Window</Command.GroupLabel>
                <Command.Item value="sidebar">
                  Hide sidebar
                  <Kbd keys="mod+b" />
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command.Root>
        </div>
        <Menu.Root defaultOpen={false}>
          <Menu.Trigger>Theme, {props.theme}</Menu.Trigger>
          <Menu.Content>
            <Menu.RadioGroup defaultValue="system">
              <Menu.GroupLabel>Theme</Menu.GroupLabel>
              <Menu.RadioItem value="system">System</Menu.RadioItem>
              <Menu.RadioItem value="dark">Dark</Menu.RadioItem>
              <Menu.RadioItem value="light">Light</Menu.RadioItem>
            </Menu.RadioGroup>
          </Menu.Content>
        </Menu.Root>
      </div>
    </Section>
  );
}
