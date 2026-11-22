import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isTauri } from "@tauri-apps/api/core";
import { Icon, Row } from "@tokamak/ui";
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
        <div class="flex flex-col gap-2 px-3">
          <h2 class="text-read font-semibold text-ink">{shell.servers.current().name} is ready</h2>
          <p class="text-read text-pretty text-ink-2">
            Tokamak runs on this computer. Work with your agents here; nothing leaves this Mac until you join
            a server.
          </p>
        </div>
        <div class="density-normal flex flex-col gap-1">
          <Show when={first()}>
            {(view) => (
              <Row
                as="button"
                lead={<Icon path={view().icon ?? shellIcons.chatNew} class="text-ink" />}
                onClick={() => shell.navigation.go(hrefOf(view()))}
              >
                <span class="text-ink">Open {view().title} on This Mac</span>
              </Row>
            )}
          </Show>
          <div class="rounded-sm surface-tray">
            <Row
              as="button"
              lead={<Icon path={shellIcons.cloud} class="text-ink" />}
              trail={<span class="text-label">Got an invite?</span>}
              onClick={() => shell.openConnect()}
            >
              <span class="text-ink">Join a friend's server</span>
            </Row>
          </div>
        </div>
      </section>
      <div class="grow-2" />
    </div>
  );
}
