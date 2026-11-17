import { createSignal, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Outlet, type AnyRouter } from "@tanstack/solid-router";
import { RegionProvider, ShortcutContext, useRegionFilled } from "@tokamak/sdk/client";
import { Button, icons } from "@tokamak/ui";
import type { PluginRouting } from "../plugins/views";
import type { ServerEndpoint } from "../plugins/adapter";
import { ShellContext, keys, type ShellState } from "./context";
import { Frame } from "./frame";
import { createNavigation } from "./navigation";
import { createSession, type Session } from "./session";
import { createShortcuts, shortcutName } from "./shortcuts";
import { createTheme } from "./theme";

export interface ShellProps {
  routing: PluginRouting;
  getEndpoint?: () => ServerEndpoint | Promise<ServerEndpoint>;
}

export function Shell(props: ShellProps): JSX.Element {
  return (
    <RegionProvider>
      <Body {...props} />
    </RegionProvider>
  );
}

function Body(props: ShellProps): JSX.Element {
  const session = createSession({ routing: props.routing, getEndpoint: props.getEndpoint });
  const shell = createShellState(props.routing.router, session);
  const navigation = shell.navigation;
  return (
    <ShellContext value={shell}>
      <ShortcutContext value={shell.shortcuts}>
        <Show when={navigation.pathname() === "/kit"} fallback={<Frame />}>
          <Button
            class="fixed end-4 top-4 z-10"
            variant="ghost"
            icon={icons.close}
            label="Close UI kit"
            onClick={() => (navigation.canBack() ? navigation.back() : navigation.go("/"))}
          />
          <Outlet />
        </Show>
      </ShortcutContext>
    </ShellContext>
  );
}

/** Everything the frame reads, with the window's keys bound. Call inside a RegionProvider. */
export function createShellState(router: AnyRouter, session: Session): ShellState {
  const views = () => {
    const connection = session.connection();
    return connection.state === "connected" ? connection.plugins.views() : [];
  };
  const navigation = createNavigation(router, views);
  const shortcuts = createShortcuts();
  const [paletteOpen, setPaletteOpen] = createSignal(false);

  const sidebarFilled = useRegionFilled("sidebar");
  const panelFilled = useRegionFilled("panel");
  const wide = window.matchMedia("(min-width: 80rem)");
  const [isWide, setWide] = createSignal(wide.matches, { ownedWrite: true });
  const onWidth = (event: MediaQueryListEvent) => setWide(event.matches);
  wide.addEventListener("change", onWidth);
  onCleanup(() => wide.removeEventListener("change", onWidth));
  // Unset means automatic: below 1280 px a filled panel takes the sidebar's room.
  const [sidebarOpen, setSidebarOpen] = createSignal<boolean>();
  const sidebarShown = () => sidebarFilled() && (sidebarOpen() ?? (isWide() || !panelFilled()));

  const shell: ShellState = {
    router,
    session,
    navigation,
    theme: createTheme(),
    shortcuts,
    sidebar: {
      filled: sidebarFilled,
      shown: sidebarShown,
      toggle: () => setSidebarOpen(!sidebarShown()),
    },
    panelFilled,
    paletteOpen,
    setPaletteOpen,
  };
  const bind = (key: string, run: () => void) =>
    onCleanup(shortcuts.registerShortcut(shortcutName(key), run));
  bind(keys.sidebar, shell.sidebar.toggle);
  bind(keys.search, () => {
    if (session.connection().state === "connected") setPaletteOpen((open) => !open);
  });
  bind(keys.back, navigation.back);
  bind(keys.forward, navigation.forward);
  bind(keys.nextTab, () => navigation.cycle(1));
  bind(keys.previousTab, () => navigation.cycle(-1));
  return shell;
}
