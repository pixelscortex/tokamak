import { createEffect } from "solid-js";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/solid-router";
import { Kit } from "./kit";
import type { ServerEndpoint } from "./plugins/adapter";
import { useShell } from "./shell/context";
import { Shell } from "./shell/shell";
import { NoPlugins, NotFound } from "./shell/states";
import { hrefOf } from "./shell/views";

let getEndpoint: (() => ServerEndpoint | Promise<ServerEndpoint>) | undefined;

const root = createRootRoute({
  component: () => <Shell routing={{ router, root, base: [home, kit] }} getEndpoint={getEndpoint} />,
});
const home = createRoute({ getParentRoute: () => root, path: "/", component: Home });
const kit = createRoute({ getParentRoute: () => root, path: "/kit", component: Kit });
export const router = createRouter({
  routeTree: root.addChildren([home, kit]),
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
    if (view) void router.navigate({ href: hrefOf(view), replace: true });
  });
  return <>{!first() && <NoPlugins />}</>;
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
