import type { JSX } from "@solidjs/web";
import { Menu } from "@tokamak/ui";
import { useShell } from "./context";
import { shellIcons } from "./icons";
import type { ThemeChoice } from "./theme";

export function SettingsMenu(props: { side: "right" | "bottom" }): JSX.Element {
  const shell = useShell();
  return (
    <Menu.Root onAction={(value) => value === "kit" && shell.navigation.go("/kit")}>
      <Menu.Trigger variant="ghost" icon={shellIcons.settings} label="Settings" />
      <Menu.Content side={props.side} align="end">
        <Menu.RadioGroup
          value={shell.theme.choice()}
          onValueChange={(value: string) => shell.theme.choose(value as ThemeChoice)}
        >
          <Menu.GroupLabel>Theme</Menu.GroupLabel>
          <Menu.RadioItem value="system">System</Menu.RadioItem>
          <Menu.RadioItem value="dark">Dark</Menu.RadioItem>
          <Menu.RadioItem value="light">Light</Menu.RadioItem>
        </Menu.RadioGroup>
        <Menu.Separator />
        <Menu.Item value="kit">UI kit</Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}
