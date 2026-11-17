import type { JSX } from "@solidjs/web";
import { Dialog, Menu, Select, Tooltip, icons } from "@tokamak/ui";
import { CommandList } from "./command.tsx";
import { Caption, Section } from "./frame.tsx";

const densities = [
  { value: "roomy", label: "Roomy" },
  { value: "normal", label: "Normal" },
  { value: "dense", label: "Dense" },
];

export function Overlays(props: { theme: string; open: boolean }): JSX.Element {
  return (
    <>
      <Section label="Primitives · Menu, Select, Tooltip, Dialog" title="Popups">
        <Caption>
          {props.open ? "Shown open. Escape closes; focus returns to the trigger." : "Closed."}
        </Caption>
        <div>
          <Dialog.Root>
            <Dialog.Trigger variant="outline">Rename thread</Dialog.Trigger>
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
        </div>
        <div class="grid grid-cols-3 items-start gap-8">
          <div>
            <Menu.Root defaultOpen={props.open} modal={false}>
              <Menu.Trigger variant="ghost" icon={icons.more} label={`Thread actions, ${props.theme}`} />
              <Menu.Content align="start">
                <Menu.Item value="rename">Rename</Menu.Item>
                <Menu.Item value="archive" shortcut="mod+e">
                  Archive
                </Menu.Item>
                <Menu.Item value="share" disabled>
                  Share
                </Menu.Item>
                <Menu.Separator />
                <Menu.Item value="delete" destructive>
                  Delete
                </Menu.Item>
              </Menu.Content>
            </Menu.Root>
          </div>
          <div>
            <Select.Root defaultValue="normal" items={densities} defaultOpen={props.open} modal={false}>
              <Select.Label>Density, {props.theme}</Select.Label>
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="roomy">Roomy</Select.Item>
                <Select.Item value="normal">Normal</Select.Item>
                <Select.Item value="dense">Dense</Select.Item>
              </Select.Content>
            </Select.Root>
          </div>
          <div>
            <Tooltip.Root defaultOpen={props.open}>
              <Tooltip.Trigger variant="ghost" icon={icons.search} label={`Search, ${props.theme}`} />
              <Tooltip.Content>Search threads</Tooltip.Content>
            </Tooltip.Root>
          </div>
        </div>
        <div aria-hidden="true" class="h-16" />
        <div aria-hidden="true" class="h-16" />
        <div aria-hidden="true" class="h-16" />
      </Section>
      <CommandList theme={props.theme} />
    </>
  );
}
