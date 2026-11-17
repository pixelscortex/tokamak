import { createContext, useContext, type Accessor, type Setter } from "solid-js";
import type { AnyRouter } from "@tanstack/solid-router";
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

export interface ShellState {
  router: AnyRouter;
  session: Session;
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
