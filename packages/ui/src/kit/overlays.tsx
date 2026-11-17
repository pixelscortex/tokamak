import type { JSX } from "@solidjs/web";
import { icons } from "../icons.ts";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../dialog.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../menu.tsx";
import { Select, SelectContent, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../select.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip.tsx";
import { Caption, Section } from "./frame.tsx";

const densities = [
  { value: "roomy", label: "Roomy" },
  { value: "normal", label: "Normal" },
  { value: "dense", label: "Dense" },
];

export function Overlays(props: { theme: string; open: boolean }): JSX.Element {
  return (
    <Section label="Primitives · Menu, Select, Tooltip, Dialog" title="Popups">
      <Caption>{props.open ? "Shown open. Escape closes; focus returns to the trigger." : "Closed."}</Caption>
      <div>
        <Dialog>
          <DialogTrigger variant="outline">Rename thread</DialogTrigger>
        <DialogBackdrop />
        <DialogContent>
          <DialogTitle>Rename thread</DialogTitle>
          <DialogDescription>Only you see the new name.</DialogDescription>
          <div class="flex justify-end gap-2">
            <DialogClose>Cancel</DialogClose>
            <DialogClose variant="brand">Save</DialogClose>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <div class="grid grid-cols-3 items-start gap-8">
        <div>
          <Menu defaultOpen={props.open} modal={false}>
            <MenuTrigger variant="ghost" icon={icons.more} label={`Thread actions, ${props.theme}`} />
            <MenuContent align="start">
              <MenuItem value="rename">Rename</MenuItem>
              <MenuItem value="archive" shortcut="mod+e">
                Archive
              </MenuItem>
              <MenuItem value="share" disabled>
                Share
              </MenuItem>
              <MenuSeparator />
              <MenuItem value="delete" destructive>
                Delete
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
        <div>
          <Select defaultValue="normal" items={densities} defaultOpen={props.open} modal={false}>
            <SelectLabel>Density, {props.theme}</SelectLabel>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="roomy">Roomy</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="dense">Dense</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Tooltip defaultOpen={props.open}>
            <TooltipTrigger variant="ghost" icon={icons.search} label={`Search, ${props.theme}`} />
            <TooltipContent>Search threads</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div aria-hidden="true" class="h-16" />
      <div aria-hidden="true" class="h-16" />
      <div aria-hidden="true" class="h-16" />
    </Section>
  );
}
