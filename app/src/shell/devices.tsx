import { createMemo, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { User } from "@tokamak/sdk";
import { Button, Icon } from "@tokamak/ui";
import { bearerHeaders } from "../host/auth";
import { readSnapshots } from "../host/snapshots";
import type { Endpoint } from "../host/endpoint";
import { useShell } from "./context";
import { shellIcons } from "./icons";
import { Unreachable } from "./states";

type DeviceEntry = {
  id: string;
  name: string;
  member: User;
  lastSeen: number | null;
  current: boolean;
  online: boolean;
};

/** A machine a plugin created (a sandbox or a VPS); the plugin manages it, so the row is read-only. */
type PluginMachineEntry = {
  id: string;
  name: string;
  owner: { kind: "plugin"; plugin: string; name: string };
  online: boolean;
  lastSeen: number | null;
  member?: { id: string; name: string };
};

const lastSeenFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "Last seen …" or "Never connected", shared by person devices and plugin machines. */
function LastSeen(props: { at: number | null }): JSX.Element {
  return (
    <Show when={props.at !== null ? new Date(props.at!) : undefined} fallback={<span>Never connected</span>}>
      {(date) => (
        <span>
          Last seen <time datetime={date().toISOString()}>{lastSeenFormat.format(date())}</time>
        </span>
      )}
    </Show>
  );
}

export function Devices(): JSX.Element {
  const shell = useShell();
  const endpoint = () => {
    const connection = shell.session.connection();
    return connection.state === "connected" ? connection.endpoint : undefined;
  };
  const unavailable = () => {
    const connection = shell.session.connection();
    return connection.state === "failed" ? connection : undefined;
  };
  return (
    <Show
      when={shell.servers.current().kind !== "local"}
      fallback={<p class="px-6 py-8 text-row text-ink-2">Devices are managed on a shared server.</p>}
    >
      <Show
        when={endpoint()}
        keyed
        fallback={
          <Show when={unavailable()} fallback={<p class="px-6 py-8 text-row text-ink-2">Connecting…</p>}>
            {(failure) => <Unreachable reason={failure().reason} needs={failure().needs} />}
          </Show>
        }
      >
        {(server) => <DevicesList endpoint={server} />}
      </Show>
    </Show>
  );
}

export function DevicesList(props: { endpoint: Endpoint }): JSX.Element {
  const [devices, setDevices] = createSignal<DeviceEntry[]>();
  const [reconnecting, setReconnecting] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  const byId = createMemo(() => new Map(devices()?.map((device) => [device.id, device])));
  const endpoint = props.endpoint;
  const closed = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;

  async function followDevices() {
    try {
      await readSnapshots<DeviceEntry[]>(endpoint, "/devices/live", closed.signal, (entries) => {
        setDevices(entries);
        setReconnecting(false);
      });
    } catch {
      // Retry with the same key while the window is still connected to this server.
    }
    if (!closed.signal.aborted) {
      setReconnecting(true);
      retry = setTimeout(followDevices, 1_000);
    }
  }
  void followDevices();
  onCleanup(() => {
    clearTimeout(retry);
    closed.abort();
  });

  async function signOut(device: DeviceEntry) {
    setProblem(undefined);
    try {
      const url = new URL(`/devices/${encodeURIComponent(device.id)}/revoke`, endpoint.http);
      const response = await fetch(url, {
        method: "POST",
        headers: bearerHeaders(endpoint.token),
        signal: AbortSignal.any([closed.signal, AbortSignal.timeout(5_000)]),
      });
      if (!response.ok) throw new Error("Sign out failed");
    } catch {
      if (!closed.signal.aborted) setProblem(`Couldn’t sign out ${device.name}. Try again.`);
    }
  }

  return (
    <section aria-label="Devices" class="mx-auto w-full max-w-read px-6 py-8 sm:px-8">
      <p class="text-row text-ink-2">Sign out a device to disconnect it from this server.</p>
      <Show when={reconnecting()}>
        <p role="status" class="mt-3 text-row text-ink-3">
          Reconnecting to the device list…
        </p>
      </Show>
      <Show when={problem()}>
        {(message) => (
          <p role="alert" class="mt-3 text-row text-removed">
            {message()}
          </p>
        )}
      </Show>
      <Show
        when={(devices()?.length ?? 0) > 0}
        fallback={
          <Show when={!reconnecting()}>
            <p class="mt-4 text-row text-ink-3">{devices() ? "No signed-in devices." : "Loading devices…"}</p>
          </Show>
        }
      >
        <ul class="mt-3">
          <For each={[...byId().keys()]}>
            {(id) => {
              const device = () => byId().get(id)!;
              const nameId = createUniqueId();
              const actionId = createUniqueId();
              return (
                <li class="flex flex-wrap items-center gap-3 border-b border-edge py-3">
                  <Icon path={shellIcons.computer} class="shrink-0 text-ink-3" />
                  <div class="min-w-0 flex-1">
                    <p class="wrap-break-word text-row font-medium text-ink">
                      <span id={nameId}>{device().name}</span>
                      <Show when={device().current}>
                        <span class="ms-2 text-label font-normal text-ink-3">This device</span>
                      </Show>
                    </p>
                    <p class="flex flex-wrap gap-x-2 text-label text-ink-3">
                      <span>{device().member.name}</span>
                      <Show when={device().online}>
                        <span>Online</span>
                      </Show>
                      <LastSeen at={device().lastSeen} />
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    aria-labelledby={`${actionId} ${nameId}`}
                    onClick={() => signOut(device())}
                  >
                    <span id={actionId}>Sign out</span>
                  </Button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <PluginMachines endpoint={endpoint} />
    </section>
  );
}

/**
 * Machines that plugins created, below people's devices. Only the owner and admins may
 * read `/devices/machines/live`: for anyone else (403), and when there are none, the group
 * is not drawn at all, so the screen stays as it was. Unreachable servers are covered by
 * the page's `Unreachable` band, so a failed stream only retries quietly.
 */
function PluginMachines(props: { endpoint: Endpoint }): JSX.Element {
  const [machines, setMachines] = createSignal<PluginMachineEntry[]>([]);
  const byId = createMemo(() => new Map(machines().map((machine) => [machine.id, machine])));
  const endpoint = props.endpoint;
  const closed = new AbortController();
  const headingId = createUniqueId();
  let retry: ReturnType<typeof setTimeout> | undefined;

  async function follow() {
    try {
      const allowed = await readSnapshots<PluginMachineEntry[]>(
        endpoint,
        "/devices/machines/live",
        closed.signal,
        setMachines,
      );
      if (!allowed) {
        // Not allowed to manage devices: the group stays hidden and is not asked again.
        setMachines([]);
        return;
      }
    } catch {
      // Keep the last list and retry while the window is still connected to this server.
    }
    if (!closed.signal.aborted) retry = setTimeout(follow, 1_000);
  }
  void follow();
  onCleanup(() => {
    clearTimeout(retry);
    closed.abort();
  });

  return (
    <Show when={machines().length > 0}>
      <section aria-labelledby={headingId} class="mt-8">
        <h3 id={headingId} class="flex h-6 items-center text-label text-ink-3">
          Plugin machines
        </h3>
        <ul class="mt-1">
          <For each={[...byId().keys()]}>
            {(id) => {
              const machine = () => byId().get(id)!;
              return (
                <li class="flex flex-wrap items-center gap-3 border-b border-edge py-3">
                  <Icon path={shellIcons.plug} class="shrink-0 text-ink-3" />
                  <div class="min-w-0 flex-1">
                    <p class="wrap-break-word text-row font-medium text-ink">{machine().name}</p>
                    <p class="flex flex-wrap gap-x-2 text-label text-ink-3">
                      <span>{machine().owner.name} plugin</span>
                      <Show when={machine().member}>{(member) => <span>For {member().name}</span>}</Show>
                      <Show when={machine().online}>
                        <span>Online</span>
                      </Show>
                      <LastSeen at={machine().lastSeen} />
                    </p>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </section>
    </Show>
  );
}
