import type { PluginView } from "../plugins/views";
import { matchRoute } from "../plugins/router";

/** The view that owns a path: an exact route match, else the longest route the path sits under. */
export function viewFor(views: readonly PluginView[], pathname: string): PluginView | undefined {
  let best: PluginView | undefined;
  let length = -1;
  for (const view of views) {
    if (safeMatch(view.route, pathname)) return view;
    const base = hrefOf(view);
    if ((pathname === base || pathname.startsWith(`${base}/`)) && base.length > length) {
      best = view;
      length = base.length;
    }
  }
  return best;
}

function safeMatch(pattern: string, pathname: string): boolean {
  try {
    return matchRoute(pattern, pathname) !== undefined;
  } catch {
    return false;
  }
}

/** The view a plain link should open: its route, unless the route needs parameters. */
export function hrefOf(view: PluginView): string {
  return view.route.replace(/\/[:*].*$/, "");
}
