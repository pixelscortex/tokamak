import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/solid-router";
import { App } from "./app";
import { Kit } from "./kit";

const root = createRootRoute({
  component: () => (
    <main>
      <header data-tauri-drag-region>
        <span>Tokamak</span>
        <small>Desktop client</small>
      </header>
      <nav aria-label="App pages">
        <Link to="/">Threads</Link>
        <Link to="/kit">UI kit</Link>
      </nav>
      <Outlet />
    </main>
  ),
});
const threads = createRoute({ getParentRoute: () => root, path: "/", component: App });
const kit = createRoute({ getParentRoute: () => root, path: "/kit", component: Kit });
export const router = createRouter({ routeTree: root.addChildren([threads, kit]) });
export function ClientRouter() {
  return <RouterProvider router={router} />;
}
declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
