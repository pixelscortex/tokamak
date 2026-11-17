import { Menu, MenuTrigger, MenuContent, MenuItem } from "@ui-sdk/solid/menu";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@ui-sdk/solid/dialog";
import {
  Select,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@ui-sdk/solid/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@ui-sdk/solid/tooltip";

export function Controls(props: { onNew: () => void; onDisconnect: () => void }) {
  return (
    <div class="controls">
      <Menu onAction={(value) => (value === "new" ? props.onNew() : props.onDisconnect())}>
        <MenuTrigger>Thread actions</MenuTrigger>
        <MenuContent>
          <MenuItem value="new">Create thread</MenuItem>
          <MenuItem value="disconnect">Disconnect</MenuItem>
        </MenuContent>
      </Menu>
      <Dialog>
        <DialogTrigger>About Tokamak</DialogTrigger>
        <DialogContent>
          <DialogTitle>Tokamak</DialogTitle>
          <DialogDescription>
            Solid 2, browser DOM, ui-sdk and the existing Tokamak WebSocket protocol.
          </DialogDescription>
          <DialogClose>Close dialog</DialogClose>
        </DialogContent>
      </Dialog>
      <Select
        defaultValue="comfortable"
        items={[
          { value: "comfortable", label: "Comfortable" },
          { value: "compact", label: "Compact" },
        ]}
      >
        <SelectLabel>Density preview</SelectLabel>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="comfortable">Comfortable</SelectItem>
          <SelectItem value="compact">Compact</SelectItem>
        </SelectContent>
      </Select>
      <Tooltip>
        <TooltipTrigger>Connection help</TooltipTrigger>
        <TooltipContent>Use the disposable loopback development server.</TooltipContent>
      </Tooltip>
    </div>
  );
}
