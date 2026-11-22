import { Button, Dialog, Menu, Select, Tooltip } from "@tokamak/ui";

export const TextStyleInButton = (props: { showActions: boolean }) => (
  <>
    <Button>
      <span class="flex gap-2">
        <span class="text-label">Merge</span>
      </span>
    </Button>
    <Menu.Trigger>{props.showActions && <span class="hover:font-semibold">Actions</span>}</Menu.Trigger>
    <Dialog.Trigger>
      <span class="text-ink-2">Open</span>
    </Dialog.Trigger>
    <Dialog.Close>
      <span class="text-row">Close</span>
    </Dialog.Close>
    <Tooltip.Trigger>
      <span class="text-data">Help</span>
    </Tooltip.Trigger>
    <Select.Trigger>
      <span class="font-medium">Density</span>
    </Select.Trigger>
  </>
);
