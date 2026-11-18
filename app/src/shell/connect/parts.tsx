import { For, Match, Show, Switch, createSignal, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Icon, icons } from "@tokamak/ui";
import { useShell } from "../context";
import { shellIcons } from "../icons";
import { shellPages } from "../pages";

const stepLabels = ["Address", "Connecting", "Verify", "Customize"] as const;

/** The quiet four-bar progress mark and the step's name. */
export function Progress(props: { step: 1 | 2 | 3 | 4 }): JSX.Element {
  return (
    <div class="flex items-center gap-3">
      <div aria-hidden="true" class="flex gap-1">
        <For each={stepLabels}>
          {(_, index) => (
            <span
              class={
                index() + 1 === props.step
                  ? "h-1 w-6 rounded-full bg-ink"
                  : index() + 1 < props.step
                    ? "h-1 w-6 rounded-full bg-ink-3"
                    : "h-1 w-6 rounded-full bg-edge"
              }
            />
          )}
        </For>
      </div>
      <p class="text-label text-ink-3">
        <span class="sr-only">Step {props.step} of 4: </span>
        {stepLabels[props.step - 1]}
      </p>
    </div>
  );
}

export function Head(props: { title: string; address?: string; children?: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-col gap-2">
      <h2 class="text-read font-semibold text-ink">{props.title}</h2>
      <Show when={props.address}>
        <p class="font-mono text-row text-ink-2">{props.address}</p>
      </Show>
      <Show when={props.children}>
        <p class="text-read text-pretty text-ink-2">{props.children}</p>
      </Show>
    </div>
  );
}

/** Cancel or back on the left, the step's one brand action on the right. */
export function Actions(props: {
  back: string;
  onBack: () => void;
  action: string;
  onAction?: () => void;
  pending?: boolean;
  busy?: boolean;
  autofocus?: boolean;
}): JSX.Element {
  return (
    <div class="flex items-center gap-2">
      <Button variant="ghost" class="-ms-3" onClick={props.onBack}>
        {props.back}
      </Button>
      <div class="flex-1" />
      <Button
        variant="brand"
        type={props.onAction ? "button" : "submit"}
        aria-disabled={props.pending || props.busy ? "true" : undefined}
        aria-busy={props.busy ? "true" : undefined}
        autofocus={props.autofocus}
        onClick={() => {
          if (!props.pending && !props.busy) props.onAction?.();
        }}
      >
        {props.action}
      </Button>
    </div>
  );
}

export function Checks(props: { children: JSX.Element }): JSX.Element {
  return (
    <ul aria-label="Checks" class="flex flex-col gap-1 rounded-md surface-tray px-4 py-3">
      {props.children}
    </ul>
  );
}

export function Check(props: {
  state: "running" | "done" | "failed";
  label: string;
  ms?: number;
}): JSX.Element {
  const [elapsed, setElapsed] = createSignal(0, { ownedWrite: true });
  if (props.state === "running") {
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    onCleanup(() => clearInterval(timer));
  }
  return (
    <li class="flex h-8 items-center gap-3">
      <Switch>
        <Match when={props.state === "running"}>
          <span class="flex motion-safe:animate-spin">
            <Icon path={icons.running} class="text-ink" label="In progress" />
          </span>
        </Match>
        <Match when={props.state === "failed"}>
          <Icon path={icons.failed} class="text-removed" label="Failed" />
        </Match>
        <Match when={props.state === "done"}>
          <Icon path={icons.done} class="text-ink-3" label="Done" />
        </Match>
      </Switch>
      <span
        class={props.state === "done" ? "flex-1 text-row text-ink-2" : "flex-1 text-row font-medium text-ink"}
      >
        {props.label}
      </span>
      <span class="text-data text-ink-3">
        {props.state === "running"
          ? `0:${String(elapsed()).padStart(2, "0")}`
          : props.ms === undefined
            ? ""
            : props.ms < 1000
              ? `${(props.ms / 1000).toFixed(1)}s`
              : `${Math.round(props.ms / 1000)}s`}
      </span>
    </li>
  );
}

export function ServerCard(props: { name: string; address: string }): JSX.Element {
  return (
    <div class="flex items-center gap-3 rounded-md surface-tray p-4">
      <span class="flex size-8 shrink-0 items-center justify-center rounded-sm bg-edge/50">
        <Icon path={shellIcons.cloud} class="text-ink" />
      </span>
      <div class="flex min-w-0 flex-col">
        <p class="truncate text-row font-medium text-ink">{props.name}</p>
        <p class="truncate text-data text-ink-3">{props.address}</p>
      </div>
    </div>
  );
}

export function Note(props: { failed?: boolean; children: JSX.Element }): JSX.Element {
  return (
    <p
      role={props.failed ? "alert" : undefined}
      class={
        props.failed
          ? "flex items-center gap-2 ps-4 text-label text-removed"
          : "flex items-center gap-2 ps-4 text-label text-ink-3"
      }
    >
      <Icon path={props.failed ? icons.failed : icons.done} size={12} />
      {props.children}
    </p>
  );
}

export function Problem(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <div role="alert" class="flex flex-col gap-1">
      <p class="flex items-center gap-2 text-row font-medium text-ink">
        <Icon path={icons.failed} class="text-removed" />
        {props.title}
      </p>
      <p class="ps-6 text-label text-pretty text-ink-3">{props.children}</p>
    </div>
  );
}

/** Servers this device has joined, most recent first; choosing one switches to it. */
export function Recent(): JSX.Element {
  const shell = useShell();
  const recent = () =>
    shell.servers
      .list()
      .filter((server) => server.kind === "remote")
      .sort((a, b) => ("lastUsed" in b ? (b.lastUsed ?? 0) : 0) - ("lastUsed" in a ? (a.lastUsed ?? 0) : 0))
      .slice(0, 5);
  return (
    <Show when={recent().length}>
      <div class="mt-4 flex flex-col gap-1">
        <h3 class="flex h-6 items-center text-label text-ink-3">Recent</h3>
        <For each={recent()}>
          {(server) => (
            <button
              type="button"
              class="-mx-2 flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-start hover:bg-hover focus-ring"
              onClick={() => {
                shell.switchServer(server.id);
                shell.navigation.close(shellPages.connect.route);
              }}
            >
              <Icon path={shellIcons.cloud} class="text-ink-3" />
              <span class="truncate text-row text-ink-2">{server.name}</span>
              <span class="min-w-0 flex-1 truncate text-data text-ink-3">
                {"address" in server ? new URL(server.address).host : ""}
              </span>
              <span class="text-data text-ink-3">{"lastUsed" in server ? age(server.lastUsed) : ""}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

function age(at: number | undefined): string {
  if (!at) return "";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
