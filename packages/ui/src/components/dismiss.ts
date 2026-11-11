/** Closing floating pieces (a select's menu) on a click outside them.
 *
 * There is no document to listen on: clicks bubble through the native tree
 * to the shell's root element, which calls `dismissOutside` (shell.tsx).
 * An open piece registers here and marks every click that passes through
 * its own element on the way up (`inside`), so the root knows which open
 * pieces the click missed. Outside a `Shell` nothing calls
 * `dismissOutside`: pieces then close only by their own keys and picks.
 * A handler that stops propagation also hides the click from the root. */
import { onCleanup } from "solid-js";

interface Layer {
  inside: boolean;
  close(): void;
}

const open = new Set<Layer>();

/** Register an open piece; it is removed when the calling owner is
 * disposed (the `<Show>` around the menu closes). Call `mark` from an
 * `onClick` on the piece's outermost element. */
export function dismissable(close: () => void): { mark(): void } {
  const layer: Layer = { inside: false, close };
  let alive = true;
  // Join after the event that opened the piece has finished bubbling: the
  // click that opens a menu (or switches to a view with one open) must not
  // reach the root as a click outside it.
  void Promise.resolve().then(() => {
    if (alive) open.add(layer);
  });
  onCleanup(() => {
    alive = false;
    open.delete(layer);
  });
  return {
    mark() {
      layer.inside = true;
    },
  };
}

/** Close every open piece the click did not pass through. */
export function dismissOutside(): void {
  for (const layer of [...open]) {
    if (!layer.inside) layer.close();
    layer.inside = false;
  }
}
