import { Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Icon, StatusIcon, Textarea, icons } from "@tokamak/ui";
import { hosted, hostedTokenKey } from "../host/endpoint";
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

export function Unreachable(props: { reason: string }): JSX.Element {
  const shell = useShell();
  const [token, setToken] = createSignal("", { ownedWrite: true });
  return (
    <Notice
      role="alert"
      label="Server unreachable"
      mark={<Icon path={icons.failed} label="Not connected" class="text-removed" />}
      title="Can't reach the Tokamak server"
      action={
        <div class="flex flex-col items-center gap-4">
          <p class="text-data text-ink-3">{props.reason}</p>
          <Show
            when={hosted()}
            fallback={
              <Button variant="primary" onClick={() => shell.session.retry()}>
                Retry
              </Button>
            }
          >
            <form
              class="flex w-full max-w-read flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                localStorage.setItem(hostedTokenKey, token());
                shell.session.retry();
              }}
            >
              <label class="text-row text-ink" for="access-token">
                Access token
              </label>
              <Textarea
                id="access-token"
                aria-label="Access token"
                autocomplete="off"
                value={token()}
                onInput={(event) => setToken(event.currentTarget.value)}
                required
              />
              <Button variant="primary" type="submit">
                Connect
              </Button>
            </form>
          </Show>
        </div>
      }
    >
      The window could not open a connection to the server.
    </Notice>
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
