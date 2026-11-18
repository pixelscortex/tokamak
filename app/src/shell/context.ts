import { createContext, useContext, type Accessor, type Setter } from "solid-js";
import type { AnyRouter } from "@tanstack/solid-router";
import type { Servers } from "../host/servers";
import type { Navigation } from "./navigation";
import type { Session } from "./session";
import type { ShellShortcuts } from "./shortcuts";
import type { Theme } from "./theme";

export const keys = {
  sidebar: "mod+b",
  search: "mod+k",
  back: "mod+[",
  forward: "mod+]",
  nextTab: "ctrl+Tab",
  previousTab: "ctrl+shift+Tab",
} as const;

/** ⌘1 to ⌘9 select the servers in the switcher's order. */
export const serverKey = (index: number) => (index < 9 ? `mod+${index + 1}` : undefined);

export interface ShellState {
  router: AnyRouter;
  session: Session;
  servers: Servers;
  /** Selects another server: its connection replaces this one and its tabs close. */
  switchServer(id: string): void;
  /** Opens the "Add a server" page, optionally starting from an address or a whole invite. */
  openConnect(invite?: string): void;
  /** Hands the invite given to openConnect to the page, once. */
  takeInvite(): string | undefined;
  serverMenuOpen: Accessor<boolean>;
  setServerMenuOpen: Setter<boolean>;
  navigation: Navigation;
  theme: Theme;
  shortcuts: ShellShortcuts;
  sidebar: {
    filled: Accessor<boolean>;
    shown: Accessor<boolean>;
    toggle(): void;
  };
  panelFilled: Accessor<boolean>;
  /** What a tab is called: the name its view gave the page when last open, else the view's title. */
  tabTitle(href: string, fallback: string): string;
  paletteOpen: Accessor<boolean>;
  setPaletteOpen: Setter<boolean>;
}

export const ShellContext = createContext<ShellState>();

export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("Shell parts render inside <Shell>");
  return shell;
}
