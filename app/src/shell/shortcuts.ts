import { onCleanup } from "solid-js";
import type { Shortcuts } from "@tokamak/sdk/client";

const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** "mod+shift+k" in Kbd notation to the facade's "Meta+Shift+k" (Control+Shift+k off Apple). */
export function shortcutName(keys: string): string {
  const parts = keys.toLowerCase().split("+");
  const key = parts.pop()!;
  const has = (name: string) => parts.includes(name);
  return [
    (has("meta") || (apple && has("mod"))) && "Meta",
    (has("ctrl") || (!apple && has("mod"))) && "Control",
    has("alt") && "Alt",
    has("shift") && "Shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}

function eventName(event: KeyboardEvent): string {
  return [
    event.metaKey && "Meta",
    event.ctrlKey && "Control",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.key.toLowerCase(),
  ]
    .filter(Boolean)
    .join("+");
}

export interface ShellShortcuts extends Shortcuts {
  /** Every key the shell or a region has claimed, for showing next to its control. */
  registered(): readonly string[];
}

export function createShortcuts(target: Document = document): ShellShortcuts {
  const handlers = new Map<string, Set<() => void | boolean>>();
  const dispatch = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    const set = handlers.get(eventName(event));
    if (!set?.size) return;
    let handled = false;
    for (const handler of set) handled = handler() !== false || handled;
    // Every handler declined (see Shortcuts.registerShortcut): the key goes on.
    if (handled) event.preventDefault();
  };
  target.addEventListener("keydown", dispatch);
  onCleanup(() => target.removeEventListener("keydown", dispatch));
  return {
    registerShortcut(key, handler) {
      const set = handlers.get(key) ?? new Set();
      set.add(handler);
      handlers.set(key, set);
      return () => {
        set.delete(handler);
        if (!set.size) handlers.delete(key);
      };
    },
    registered: () => [...handlers.keys()],
  };
}
