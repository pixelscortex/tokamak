import { Button, Row, Tooltip } from "@tokamak/ui";

export const FixedControlSizes = () => (
  <div class="mt-2 flex flex-col gap-2 density-dense">
    <Button class="mt-2" lead={<span class="flex text-trim" />}>
      <span class="flex gap-2">
        <span class="sr-only">Open </span>
        <span class="truncate text-ellipsis text-trim">Actions</span>
      </span>
    </Button>
    <Row as="button" selected trail={<span class="text-label italic">Default</span>}>
      <span class="font-medium">No folder</span>
    </Row>
    <Tooltip.Root>
      <Tooltip.Trigger>Help</Tooltip.Trigger>
      <Tooltip.Content>
        <span class="text-label text-ink-2">What is density?</span>
      </Tooltip.Content>
    </Tooltip.Root>
  </div>
);
