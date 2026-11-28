import { createEffect } from "solid-js";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/solid-router";
import { Kit } from "./kit";
import type { ServerEndpoint } from "./plugins/adapter";
import { useShell } from "./shell/context";
import { Connect } from "./shell/connect/flow";
import { Devices } from "./shell/devices";
import { Members } from "./shell/members";
import { Plugins } from "./shell/plugins";
import { Shell } from "./shell/shell";
import { NoPlugins, NotFound } from "./shell/states";
import { hrefOf } from "./shell/views";
import { Welcome, welcomeDue } from "./shell/welcome";

let getEndpoint: (() => ServerEndpoint | Promise<ServerEndpoint>) | undefined;

const root = createRootRoute({
  component: () => <Shell routing={{ router, root, base }} getEndpoint={getEndpoint} />,
});
const home = createRoute({ getParentRoute: () => root, path: "/", component: Home });
const kit = createRoute({ getParentRoute: () => root, path: "/kit", component: Kit });
const connect = createRoute({ getParentRoute: () => root, path: "/connect", component: Connect });
const welcome = createRoute({ getParentRoute: () => root, path: "/welcome", component: Welcome });
const join = createRoute({ getParentRoute: () => root, path: "/join", component: Join });
const devices = createRoute({ getParentRoute: () => root, path: "/settings/devices", component: Devices });
const members = createRoute({ getParentRoute: () => root, path: "/settings/members", component: Members });
const plugins = createRoute({ getParentRoute: () => root, path: "/settings/plugins", component: Plugins });
const base = [home, kit, connect, welcome, join, devices, members, plugins];
export const router = createRouter({
  routeTree: root.addChildren(base),
  defaultNotFoundComponent: NotFound,
});

/** "/" opens the first view, or says that there is none yet. */
function Home() {
  const shell = useShell();
  const first = () => {
    const connection = shell.session.connection();
    return connection.state === "connected" ? connection.plugins.views()[0] : undefined;
  };
  createEffect(first, (view) => {
    if (!view) return;
    void router.navigate({ href: welcomeDue(shell) ? "/welcome" : hrefOf(view), replace: true });
  });
  return <>{!first() && <NoPlugins />}</>;
}

/**
 * An invite opened in a browser: `https://<server>/join#<token>`. The server serves the
 * app here, so the page hands the invite to "Add a server" and drops it from the address.
 */
function Join() {
  const shell = useShell();
  const invite = window.location.href;
  window.history.replaceState(window.history.state, "", "/join");
  if (invite.includes("#")) shell.openConnect(invite);
  else void router.navigate({ href: "/", replace: true });
  return null;
}

export function ClientRouter(props: { getEndpoint?: () => ServerEndpoint | Promise<ServerEndpoint> }) {
  getEndpoint = props.getEndpoint;
  return <RouterProvider router={router} />;
}
declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
