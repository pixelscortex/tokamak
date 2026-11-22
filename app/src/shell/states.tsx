import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Icon, StatusIcon, icons } from "@tokamak/ui";
import { useShell } from "./context";
import { shellIcons } from "./icons";
import { hrefOf } from "./views";

/** A centred notice on the stage: a mark, a 16/26 heading, one line, then its action. */
export function Notice(props: {
  mark: JSX.Element;
  title: string;
  children?: JSX.Element;
  action?: JSX.Element;
  role?: "alert" | "status";
  label?: string;
}): JSX.Element {
  return (
    <div
      role={props.role}
      aria-label={props.label}
      class="m-auto flex max-w-read flex-col items-center gap-6 px-8 py-16 text-center"
    >
      <div class="flex flex-col items-center gap-2">
        <span class="mb-2 text-ink-3">{props.mark}</span>
        <h2 class="text-read font-semibold text-ink">{props.title}</h2>
        <Show when={props.children}>
          <p class="text-read text-pretty text-ink-2">{props.children}</p>
        </Show>
      </div>
      {props.action}
    </div>
  );
}

export function Connecting(): JSX.Element {
  return (
    <div class="m-auto flex items-center gap-2 text-row text-ink-3" role="status" aria-label="Connecting">
      <StatusIcon status="running" label="Connecting to the Tokamak server" />
      <span>Connecting</span>
    </div>
  );
}

/**
 * The selected server cannot be reached. A band on the stage, not a wall: the frame,
 * the switcher and the tabs stay usable around it.
 */
export function Unreachable(props: { reason: string; needs?: "token" }): JSX.Element {
  const shell = useShell();
  const server = shell.servers.current;
  const address = () => {
    const current = server();
    return current.kind === "local" ? undefined : current.address;
  };
  return (
    <div class="m-auto w-full max-w-thread px-8 py-16">
      <div
        role="alert"
        aria-label="Server unreachable"
        class="flex flex-wrap items-center gap-3 rounded-lg surface-band py-2 ps-4 pe-2"
      >
        <Icon path={icons.failed} label="Not connected" class="text-removed" />
        <div class="flex min-w-0 flex-1 flex-col">
          <p class="text-row font-medium text-ink">
            {props.needs === "token"
              ? `${server().name} needs you to sign in`
              : `Can't reach ${server().name}`}
          </p>
          <p class="text-label text-ink-3">
            <Show when={address() && !props.reason.includes(new URL(address()!).host) && address()}>
              {(origin) => <span class="text-data">{new URL(origin()).host} </span>}
            </Show>
            {props.reason}
          </p>
        </div>
        <Button variant="ghost" onClick={() => shell.setServerMenuOpen(true)}>
          Connect to another server
        </Button>
        <Show
          when={props.needs === "token" && address()}
          fallback={
            <Button variant="quiet" onClick={() => shell.session.retry()}>
              Retry
            </Button>
          }
        >
          {(origin) => (
            <Button
              variant="quiet"
              onClick={() =>
                shell.openSignIn({
                  origin: origin(),
                  onInvite: () => shell.openConnect(origin()),
                })
              }
            >
              Sign in
            </Button>
          )}
        </Show>
      </div>
    </div>
  );
}

export function NoPlugins(): JSX.Element {
  return (
    <Notice
      mark={<Icon path={shellIcons.plug} />}
      title="No plugins installed"
      role="status"
      label="No plugins"
    >
      Everything in Tokamak comes from a plugin. Install one on the server and its views open here.
    </Notice>
  );
}

export function NotFound(): JSX.Element {
  const shell = useShell();
  const first = () => {
    const connection = shell.session.connection();
    return connection.state === "connected" ? connection.plugins.views()[0] : undefined;
  };
  return (
    <Notice
      mark={<Icon path={shellIcons.view} />}
      title="Nothing here"
      action={
        <Show when={first()}>
          {(view) => <Button onClick={() => shell.navigation.go(hrefOf(view()))}>Open {view().title}</Button>}
        </Show>
      }
    >
      No installed view answers this address. Its plugin may have been removed.
    </Notice>
  );
}
