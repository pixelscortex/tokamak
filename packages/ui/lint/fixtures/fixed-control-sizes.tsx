import { Button, Row, Tooltip } from "@tokamak/ui";

export const FixedControlSizes = () => (
  <div class="mt-2 flex flex-col gap-2 density-dense">
    <Button class="mt-2">
      <span class="flex gap-2">
        <span class="sr-only">Open </span>
        <span class="truncate text-ellipsis">Actions</span>
      </span>
    </Button>
    <Row as="button" selected>
      No folder
    </Row>
    <Tooltip.Root>
      <Tooltip.Trigger>Help</Tooltip.Trigger>
      <Tooltip.Content>
        <span class="text-label text-ink-2">What is density?</span>
      </Tooltip.Content>
    </Tooltip.Root>
  </div>
);
