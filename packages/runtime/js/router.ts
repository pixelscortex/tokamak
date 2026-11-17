/** The legacy plugin navigation surface backed by the shell TanStack history. */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRouter,
} from "@tanstack/solid-router";
import { createContext, useContext, createSignal, getOwner, onCleanup, type Accessor } from "solid-js";

export interface RouteLocation {
  readonly href: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}
export interface RouteMatch {
  readonly params: Readonly<Record<string, string>>;
}
export interface MemoryRouter {
  readonly location: Accessor<RouteLocation>;
  navigate(href: string, options?: { replace?: boolean }): void;
  back(): void;
  forward(): void;
  match(pattern: string): RouteMatch | undefined;
  dispose(): void;
}

function checkHref(href: string): void {
  if (
    typeof href !== "string" ||
    href.length > 2048 ||
    !href.startsWith("/") ||
    href.startsWith("//") ||
    /[\\\x00-\x20\x7f]/.test(href)
  ) {
    throw new Error("Routes must be local absolute paths, at most 2048 characters");
  }
}

/** Exact segments, :parameters and one terminal *splat; no browser URL parser. */
export function matchRoute(pattern: string, pathname: string): RouteMatch | undefined {
  checkHref(pattern);
  checkHref(pathname);
  if (pattern.includes("?") || pattern.includes("#")) throw new Error("Route patterns contain paths only");
  const segments = (value: string) => (value === "/" ? [] : value.replace(/\/$/, "").slice(1).split("/"));
  const expected = segments(pattern);
  const actual = segments(pathname);
  const params: Record<string, string> = Object.create(null);
  for (let index = 0; index < expected.length; index++) {
    const part = expected[index]!;
    const parameter = part.startsWith(":") || part.startsWith("*");
    const name = part.slice(1);
    if (parameter && (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || Object.hasOwn(params, name))) {
      throw new Error("Invalid or duplicate route parameter");
    }
    if (part.startsWith("*") && index !== expected.length - 1) throw new Error("Route splats must be last");
    try {
      if (part.startsWith("*")) {
        params[name] = actual.slice(index).map(decodeURIComponent).join("/");
        return Object.freeze({ params: Object.freeze(params) });
      }
      if (actual[index] === undefined || actual[index] === "") return;
      const value = decodeURIComponent(actual[index]!);
      if (part.startsWith(":")) params[name] = value;
      else if (value !== part) return;
    } catch {
      return;
    } // Malformed encoded route input is a non-match.
  }
  return expected.length === actual.length ? Object.freeze({ params: Object.freeze(params) }) : undefined;
}

export function createMemoryRouter(initial = "/"): MemoryRouter {
  checkHref(initial);
  const root = createRootRoute();
  const catchAll = createRoute({ getParentRoute: () => root, path: "$" });
  return routerFacade(
    createRouter({
      routeTree: root.addChildren([catchAll]),
      history: createMemoryHistory({ initialEntries: [initial] }),
    }),
    true,
  );
}

export function routerFacade(router: AnyRouter, ownsHistory = false): MemoryRouter {
  const snapshot = (): RouteLocation => {
    const { href, pathname, search, hash } = router.history.location;
    return { href, pathname, search, hash };
  };
  const [location, setLocation] = createSignal(snapshot(), { ownedWrite: true });
  const unsubscribe = router.history.subscribe(() => setLocation(snapshot()));
  let disposed = false;
  const live = () => {
    if (disposed) throw new Error("Router is disposed");
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    if (ownsHistory) router.history.destroy();
  };
  if (getOwner()) onCleanup(dispose);
  return {
    location,
    navigate(href, options) {
      live();
      checkHref(href);
      void router.navigate({ href, replace: options?.replace });
    },
    back() {
      live();
      router.history.back();
    },
    forward() {
      live();
      router.history.forward();
    },
    match: (pattern) => matchRoute(pattern, location().pathname),
    dispose,
  };
}

/** Navigation is owned by the shell, shared through the same Solid context as
 * plugin components. A plugin never needs to construct a second history. */
export const RouterContext = createContext<MemoryRouter>();
export function useRouter(): MemoryRouter {
  const router = useContext(RouterContext);
  if (!router) throw new Error("Plugin UI requires the shell router");
  return router;
}
