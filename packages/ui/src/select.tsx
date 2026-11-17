/*
  <Select defaultValue="normal" items={densities}>
    <SelectLabel>Density</SelectLabel>
    <SelectTrigger>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="roomy">Roomy</SelectItem>
      <SelectItem value="normal">Normal</SelectItem>
    </SelectContent>
  </Select>

  ui-sdk Select. The trigger looks like a neutral button with a chevron;
  the list is the same card as Menu, and the selected item carries a check.
  Slots: select-label (12/16 label), select-trigger, select-value,
  select-content, select-item.
*/
export {
  Select,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectGroupLabel,
  SelectSeparator,
} from "@ui-sdk/solid/select";
