import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isTauri } from "@tauri-apps/api/core";
import { Icon } from "@tokamak/ui";
import { useShell, type ShellState } from "./context";
import { shellIcons } from "./icons";
import { hrefOf } from "./views";

const welcomedKey = "tokamak.welcomed";

/** The desktop app's first start on This Mac opens the welcome page once. */
export function welcomeDue(shell: ShellState): boolean {
  return isTauri() && shell.servers.current().kind === "local" && !localStorage.getItem(welcomedKey);
}

/** This Mac is ready, with a quiet way to join someone else's server. */
export function Welcome(): JSX.Element {
  const shell = useShell();
  localStorage.setItem(welcomedKey, "1");
  const first = () => {
    const connection = shell.session.connection();
    return connection.state === "connected" ? connection.plugins.views()[0] : undefined;
  };
  return (
    <div class="flex min-h-0 flex-1 flex-col items-center overflow-auto px-8 py-16">
      <div class="flex-1" />
      <section aria-label="Welcome" class="flex w-full max-w-dialog flex-col gap-8">
        <div class="flex flex-col gap-2">
          <h2 class="text-read font-semibold text-ink">{shell.servers.current().name} is ready</h2>
          <p class="text-read text-pretty text-ink-2">
            Tokamak runs on this computer. Work with your agents here; nothing leaves this Mac until you join
            a server.
          </p>
        </div>
        <div class="-mx-2 flex flex-col gap-1 density-normal">
          <Show when={first()}>
            {(view) => (
              <button
                type="button"
                class="flex h-row cursor-pointer items-center gap-2 rounded-sm px-2 text-start hover:bg-hover focus-ring"
                onClick={() => shell.navigation.go(hrefOf(view()))}
              >
                <Icon path={view().icon ?? shellIcons.chatNew} class="text-ink" />
                <span class="flex-1 text-row text-ink">Open {view().title} on This Mac</span>
              </button>
            )}
          </Show>
          <button
            type="button"
            class="flex h-row cursor-pointer items-center gap-2 rounded-sm bg-hover px-2 text-start hover:bg-selected focus-ring"
            onClick={() => shell.openConnect()}
          >
            <Icon path={shellIcons.cloud} class="text-ink" />
            <span class="flex-1 text-row text-ink">Join a friend's server</span>
            <span class="text-label text-ink-3">Got an invite?</span>
          </button>
        </div>
      </section>
      <div class="grow-2" />
    </div>
  );
}
