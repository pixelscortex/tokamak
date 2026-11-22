import { For, Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { within } from "@tokamak/sdk";
import { quitBlockers, type QuitBlocker } from "@tokamak/sdk/client";
import { Button, Dialog } from "@tokamak/ui";
import { cancelQuit, confirmQuit, holdQuit, listenForQuit } from "../host/quit";

/** Stop and quit gives up waiting after this long; quitting closes whatever is left. */
const STOP_LIMIT_MS = 20_000;

/**
 * Asks before quitting while a plugin still has work on this computer
 * ("Claude is still working in 1 thread · Stop and quit · Cancel"). Plugins
 * report work with `onQuit`; with none, the app quits without a dialog.
 */
export function QuitDialog(): JSX.Element {
  const [blockers, setBlockers] = createSignal<readonly QuitBlocker[]>([]);
  const [stopping, setStopping] = createSignal(false);
  let asking = false;

  listenForQuit(async () => {
    if (asking) return;
    asking = true;
    const found = await quitBlockers();
    if (found.length === 0) return void (await confirmQuit());
    await holdQuit();
    setBlockers(found);
  });

  function cancel() {
    if (stopping()) return;
    asking = false;
    setBlockers([]);
    void cancelQuit();
  }

  async function stopAndQuit() {
    setStopping(true);
    await within(Promise.allSettled(blockers().map((blocker) => blocker.stop())), STOP_LIMIT_MS);
    await confirmQuit();
  }

  return (
    <Show when={blockers().length > 0}>
      <Dialog.Root open onOpenChange={(open) => !open && cancel()}>
        <Dialog.Content>
          <Dialog.Title>
            <For each={blockers()}>{(blocker) => <span class="block">{blocker.message}</span>}</For>
          </Dialog.Title>
          <Dialog.Description>
            {stopping() ? "Stopping…" : "Quitting stops it. The reply so far is kept."}
          </Dialog.Description>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" disabled={stopping()} onClick={cancel}>
              Cancel
            </Button>
            <Button variant="primary" disabled={stopping()} onClick={() => void stopAndQuit()}>
              Stop and quit
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Root>
    </Show>
  );
}
