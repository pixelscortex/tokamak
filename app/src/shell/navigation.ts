import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import type { AnyRouter } from "@tanstack/solid-router";
import type { PluginView } from "../plugins/views";
import { hrefOf, viewFor } from "./views";

export interface Tab {
  href: string;
  view: PluginView;
}

export interface Navigation {
  pathname: Accessor<string>;
  /** The view under the current path, if any. */
  current: Accessor<PluginView | undefined>;
  tabs: Accessor<readonly Tab[]>;
  active: Accessor<string>;
  canBack: Accessor<boolean>;
  canForward: Accessor<boolean>;
  back(): void;
  forward(): void;
  go(href: string): void;
  openView(view: PluginView): void;
  openNew(href: string): void;
  close(href: string): void;
  cycle(step: 1 | -1): void;
}

const same = (a: PluginView, b: PluginView) => a.plugin === b.plugin && a.id === b.id;

/**
 * One tab per open route. A route a view navigates to inside its own tab replaces that
 * tab's address; a route under another view opens a tab after the active one.
 */
export function createNavigation(router: AnyRouter, views: Accessor<readonly PluginView[]>): Navigation {
  const read = () => {
    const { pathname, search, state } = router.history.location;
    return { href: pathname + search, pathname, index: state.__TSR_index ?? 0 };
  };
  const [location, setLocation] = createSignal(read(), { ownedWrite: true });
  const [furthest, setFurthest] = createSignal(read().index, { ownedWrite: true });
  const unsubscribe = router.history.subscribe(({ action }: { action: { type: string } }) => {
    const next = read();
    setLocation(next);
    setFurthest((value) => (action.type === "PUSH" ? next.index : Math.max(value, next.index)));
  });
  onCleanup(unsubscribe);

  const [hrefs, setHrefs] = createSignal<readonly string[]>([], { ownedWrite: true });
  const [active, setActive] = createSignal("", { ownedWrite: true });
  let opening = false;

  const tabs = () =>
    hrefs().flatMap((href) => {
      const view = viewFor(views(), href.split("?")[0]!);
      return view ? [{ href, view }] : [];
    });

  createEffect(
    () => ({ at: location(), list: views() }),
    ({ at, list }) =>
      untrack(() => {
        const view = viewFor(list, at.pathname);
        if (!view) return;
        const open = hrefs().filter((href) => viewFor(list, href.split("?")[0]!));
        if (!open.includes(at.href)) {
          const from = open.indexOf(active());
          const fromView = from >= 0 ? viewFor(list, open[from]!.split("?")[0]!) : undefined;
          const next = [...open];
          if (!opening && fromView && same(fromView, view)) next[from] = at.href;
          else next.splice(from + 1, 0, at.href);
          setHrefs(next);
        } else if (open.length !== hrefs().length) setHrefs(open);
        opening = false;
        setActive(at.href);
      }),
  );

  const go = (href: string) => void router.navigate({ href });
  return {
    pathname: () => location().pathname,
    current: () => viewFor(views(), location().pathname),
    tabs,
    active: () => (tabs().some((tab) => tab.href === location().href) ? location().href : ""),
    canBack: () => location().index > 0,
    canForward: () => location().index < furthest(),
    back: () => router.history.back(),
    forward: () => router.history.forward(),
    go,
    openView(view) {
      const tab = tabs().find((candidate) => same(candidate.view, view));
      if (tab) go(tab.href);
      else this.openNew(hrefOf(view));
    },
    openNew(href) {
      if (hrefs().includes(href)) return go(href);
      opening = true;
      go(href);
    },
    close(href) {
      const list = tabs();
      const index = list.findIndex((tab) => tab.href === href);
      if (index < 0 || list.length < 2) return;
      setHrefs(hrefs().filter((candidate) => candidate !== href));
      if (href === location().href) go((list[index + 1] ?? list[index - 1])!.href);
    },
    cycle(step) {
      const list = tabs();
      if (list.length < 2) return;
      const index = list.findIndex((tab) => tab.href === location().href);
      go(list[(index + step + list.length) % list.length]!.href);
    },
  };
}
