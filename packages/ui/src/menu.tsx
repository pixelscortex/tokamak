/*
  <Menu onAction={run}>
    <MenuTrigger variant="ghost" icon={icons.more} label="Thread actions" />
    <MenuContent>
      <MenuItem value="rename">Rename</MenuItem>
      <MenuItem value="archive" shortcut="mod+e">Archive</MenuItem>
      <MenuSeparator />
      <MenuItem value="delete" destructive>Delete</MenuItem>
    </MenuContent>
  </Menu>

  ui-sdk Menu with Tokamak looks. The trigger takes the Button look props.
  The popup is a card with 4 padding and radius 12; items are 32 rows with
  radius 8 (12 − 4). Shortcuts show in data mono at the end of the item.
  Slots: menu-trigger, menu-content, menu-item (with menu-item-icon,
  menu-shortcut), menu-separator, menu-group-label.
*/
import { MenuTrigger as UiMenuTrigger } from "@ui-sdk/solid/menu";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { LookContent, lookAttributes, lookKeys, type ButtonLook } from "./button.tsx";

export {
  Menu,
  MenuContent,
  MenuItem,
  MenuItemIcon,
  MenuSeparator,
  MenuGroup,
  MenuGroupLabel,
  MenuCheckboxItem,
  MenuItemIndicator,
  MenuSub,
  MenuSubTrigger,
  MenuSubContent,
} from "@ui-sdk/solid/menu";

export type MenuTriggerProps = Omit<ComponentProps<typeof UiMenuTrigger>, "children"> & ButtonLook;

export function MenuTrigger(props: MenuTriggerProps): JSX.Element {
  const rest = omit(props, ...lookKeys);
  return (
    <UiMenuTrigger {...rest} {...lookAttributes(props)}>
      <LookContent {...props} />
    </UiMenuTrigger>
  );
}
