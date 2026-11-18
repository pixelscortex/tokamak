import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

export type ThemeChoice = "system" | "dark" | "light";
const key = "tokamak.theme";

export interface Theme {
  choice: Accessor<ThemeChoice>;
  resolved: Accessor<"dark" | "light">;
  choose(choice: ThemeChoice): void;
}

export function createTheme(root: HTMLElement = document.documentElement): Theme {
  const stored = localStorage.getItem(key);
  const [choice, setChoice] = createSignal<ThemeChoice>(
    stored === "dark" || stored === "light" ? stored : "system",
    { ownedWrite: true },
  );
  const query = window.matchMedia("(prefers-color-scheme: light)");
  const [systemLight, setSystemLight] = createSignal(query.matches, { ownedWrite: true });
  const listener = (event: MediaQueryListEvent) => setSystemLight(event.matches);
  query.addEventListener("change", listener);
  onCleanup(() => query.removeEventListener("change", listener));

  const resolved = () => {
    const current = choice();
    if (current !== "system") return current;
    return systemLight() ? "light" : "dark";
  };
  createEffect(resolved, (theme) => {
    root.dataset.theme = theme;
  });
  return {
    choice,
    resolved,
    choose(next) {
      setChoice(next);
      if (next === "system") localStorage.removeItem(key);
      else localStorage.setItem(key, next);
    },
  };
}
