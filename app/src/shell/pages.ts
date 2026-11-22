import type { PluginView } from "../plugins/views";
import { shellIcons } from "./icons";

/**
 * Pages the shell owns. They open as tabs like plugin views do, and they render
 * whatever the connection is doing, so they stay usable when a server is not.
 */
export const shellPages = {
  connect: {
    id: "connect",
    plugin: "shell",
    route: "/connect",
    title: "Add a server",
    icon: shellIcons.cloud,
    generation: 0,
  },
  welcome: {
    id: "welcome",
    plugin: "shell",
    route: "/welcome",
    title: "Welcome",
    icon: shellIcons.computer,
    generation: 0,
  },
  members: {
    id: "members",
    plugin: "shell",
    route: "/settings/members",
    title: "Members",
    icon: shellIcons.members,
    generation: 0,
  },
  devices: {
    id: "devices",
    plugin: "shell",
    route: "/settings/devices",
    title: "Devices",
    icon: shellIcons.computer,
    generation: 0,
  },
} satisfies Record<string, PluginView>;

export const shellPageList: readonly PluginView[] = Object.values(shellPages);

/** Shell pages, plus /join, which hands an invite link to "Add a server". */
export const isShellPage = (pathname: string) =>
  pathname === "/join" || shellPageList.some((page) => page.route === pathname);
