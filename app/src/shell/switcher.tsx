import { For, Show, createEffect, createSignal, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { MenuTrigger } from "@ui-sdk/solid/menu";
import { Button, Dialog, Icon, Menu, cn, icons } from "@tokamak/ui";
import { reach } from "../host/reach";
import type { Server } from "../host/servers";
import { serverKey, useShell } from "./context";
import { Field } from "./field";
import { shellIcons } from "./icons";

/** What the switcher knows about a server: the live connection for the current one, a probe for the rest. */
type Status = "connected" | "connecting" | "failed" | "reachable" | "checking" | "silent";

const words: Record<Status, string> = {
  connected: "connected",
  connecting: "connecting",
  failed: "not connected",
  reachable: "answering",
  checking: "checking",
  silent: "not answering",
};

export const kindIcon = (server: Server) =>
  server.kind === "local" ? shellIcons.computer : shellIcons.cloud;

/** A 16 px lead: the state when there is one worth showing, else what kind of server it is. */
function Mark(props: { server: Server; status?: Status; quiet?: boolean }): JSX.Element {
  return (
    <span class="flex w-4 shrink-0 justify-center">
      <Show
        when={props.status === "connecting" || props.status === "checking"}
        fallback={
          <Show
            when={props.status === "failed" || props.status === "silent"}
            fallback={
              <Icon
                path={
                  !props.quiet && (props.status === "connected" || props.status === "reachable")
                    ? icons.done
                    : kindIcon(props.server)
                }
                class={props.quiet ? "text-ink" : "text-ink-3"}
              />
            }
          >
            <Icon path={icons.failed} class="text-removed" />
          </Show>
        }
      >
        <span class="flex motion-safe:animate-spin">
          <Icon path={icons.running} class="text-ink-3" />
        </span>
      </Show>
    </span>
  );
}

/**
 * The current server and the menu that switches it. It heads the sidebar column; with
 * the sidebar hidden it sits in the top strip as one icon button (`compact`).
 */
export function ServerSwitcher(props: { compact?: boolean }): JSX.Element {
  const shell = useShell();
  const servers = shell.servers;
  const current = servers.current;
  const live = (): Status => {
    const state = shell.session.connection().state;
    return state === "connected" ? "connected" : state === "connecting" ? "connecting" : "failed";
  };
  const [probes, setProbes] = createSignal<Readonly<Record<string, Status>>>({}, { ownedWrite: true });
  const status = (server: Server): Status | undefined =>
    server.id === current().id ? live() : probes()[server.id];

  // Opening the menu asks every other server whether it answers; closing it stops asking.
  createEffect(shell.serverMenuOpen, (open) => {
    if (!open) return;
    const controller = new AbortController();
    const others = untrack(servers.list).filter((server) => server.id !== untrack(current).id);
    setProbes(Object.fromEntries(others.map((server) => [server.id, "checking" as Status])));
    for (const server of others)
      void servers
        .endpointOf(server)
        .then((endpoint) => reach(endpoint.http, { signal: controller.signal, timeout: 5_000 }))
        .then((answer) => (answer.ok ? "reachable" : "silent"))
        .catch((): Status => "silent")
        .then((next) => {
          if (!controller.signal.aborted) setProbes((previous) => ({ ...previous, [server.id]: next }));
        });
    return () => controller.abort();
  });

  const [renaming, setRenaming] = createSignal(false, { ownedWrite: true });
  const act = (value: string) => {
    if (value.startsWith("server:")) shell.switchServer(value.slice("server:".length));
    else if (value === "add") shell.openConnect();
    else if (value === "rename") setRenaming(true);
    else if (value === "remove") {
      const id = current().id;
      servers.remove(id);
      shell.navigation.reset();
    }
  };

  const triggerName = () => {
    const state = live();
    return `Server: ${current().name}${state === "connected" ? "" : `, ${words[state]}`}`;
  };
  const lead = () => {
    const state = live();
    return state === "connected" ? undefined : state;
  };

  return (
    <>
      <Menu.Root
        open={shell.serverMenuOpen()}
        onOpenChange={(open) => shell.setServerMenuOpen(open)}
        onAction={act}
      >
        <Show
          when={props.compact}
          fallback={
            <MenuTrigger
              aria-label={triggerName()}
              class="mb-2 flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-start text-row font-medium text-ink transition duration-200 hover:bg-hover data-open:bg-selected focus-ring"
            >
              <Mark server={current()} status={lead()} quiet />
              <span class="min-w-0 flex-1 truncate">{current().name}</span>
              <Icon path={shellIcons.expand} size={12} class="text-ink-3" />
            </MenuTrigger>
          }
        >
          <MenuTrigger
            aria-label={triggerName()}
            class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-sm text-ink-2 transition duration-200 hover:bg-hover hover:text-ink data-open:bg-selected focus-ring"
          >
            <Mark server={current()} status={lead()} quiet />
          </MenuTrigger>
        </Show>
        <Menu.Content side="bottom" align="start">
          <For each={servers.list()}>
            {(server, index) => {
              const selected = () => server.id === current().id;
              const state = () => status(server);
              return (
                <Menu.Item
                  value={`server:${server.id}`}
                  shortcut={serverKey(index())}
                  aria-current={selected() ? "true" : undefined}
                  aria-label={state() ? `${server.name}, ${words[state()!]}` : server.name}
                >
                  <Mark server={server} status={state()} />
                  <span class={cn("min-w-0 flex-1 truncate", selected() ? "font-medium" : "text-ink-2")}>
                    {server.name}
                  </span>
                </Menu.Item>
              );
            }}
          </For>
          <Show when={servers.canAdd || current().kind === "remote"}>
            <Menu.Separator />
          </Show>
          <Show when={servers.canAdd}>
            <Menu.Item value="add">
              <span class="flex w-4 shrink-0 justify-center">
                <Icon path={icons.add} class="text-ink-3" />
              </span>
              <span class="text-ink-2">Add server…</span>
            </Menu.Item>
          </Show>
          <Show when={current().kind === "remote"}>
            <Menu.Item value="rename">
              <span class="w-4 shrink-0" />
              <span class="min-w-0 flex-1 truncate text-ink-2">Rename this server…</span>
            </Menu.Item>
            <Menu.Item value="remove" destructive>
              <span class="w-4 shrink-0" />
              <span class="min-w-0 flex-1 truncate">Remove this server</span>
            </Menu.Item>
          </Show>
        </Menu.Content>
      </Menu.Root>
      <RenameDialog open={renaming()} onOpenChange={setRenaming} />
    </>
  );
}

function RenameDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  const shell = useShell();
  const [name, setName] = createSignal("", { ownedWrite: true });
  createEffect(
    () => props.open,
    (open) => {
      if (open) setName(untrack(shell.servers.current).name);
    },
  );
  const save = (event: SubmitEvent) => {
    event.preventDefault();
    if (!name().trim()) return;
    shell.servers.rename(shell.servers.current().id, name());
    props.onOpenChange(false);
  };
  return (
    <Dialog.Root open={props.open} onOpenChange={(open: boolean) => props.onOpenChange(open)}>
      <Dialog.Backdrop />
      <Dialog.Content>
        <form class="flex flex-col gap-6" onSubmit={save}>
          <div class="flex flex-col gap-2">
            <Dialog.Title>Rename server</Dialog.Title>
            <Dialog.Description>Only this device sees the name.</Dialog.Description>
          </div>
          <Field label="Server name" value={name()} onInput={setName} autofocus />
          <div class="flex justify-end gap-2">
            <Dialog.Close variant="ghost">Cancel</Dialog.Close>
            <Button variant="brand" type="submit" aria-disabled={name().trim() ? undefined : "true"}>
              Save
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
