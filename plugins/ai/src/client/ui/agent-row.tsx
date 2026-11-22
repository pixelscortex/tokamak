import { For, Show, createEffect, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TokamakClient } from "@tokamak/sdk";
import { auth, useClient, useQuery, useShortcuts } from "@tokamak/sdk/client";
import { Menu } from "@tokamak/ui";
import { holdSend, type ComposerProps } from "plugin:chat/client";
import type { Picked } from "../../shared/offered";
import { errorText, isSendersDevice } from "../../shared/turn-shared";
import { agents, api, modelLabel, notice, refreshAgents, unavailable } from "../lib/agents";
import {
  ACCESS_LABEL,
  creatorOnlyLine,
  deviceChoices,
  label,
  newThreadChoices,
  pick,
  storedChoices,
  type Access,
  type Change,
  type Resolved,
} from "../lib/choices";
import { watchQuestions } from "../lib/questions";
import { listenForQueue } from "../lib/turn";
import { activeFor, localActiveTurn, onTurnDraft, stopTurn } from "../lib/turn-controls";
import { AgentMark } from "./agent-mark";

/**
 * The agent row under the composer box (Paper "Stage · thread", composer):
 * separate pickers for agent (its mark and name), model, level,
 * speed, mode and permission level on the left, a short line on the right.
 * The pickers are quiet text until hovered; no chevrons. A picker hides when the agent offers
 * nothing for it; each one asks every agent for its `info` again as it opens.
 * The choices belong to the thread (the new thread's stay in this window
 * until its first Send). A missing or signed-out agent shows only its line,
 * and Send stays off in this composer until it is fixed; the agent picker
 * always opens, so even a single agent can be asked again.
 *
 * Empty when no agent plugin is installed or there is no local part (a plain
 * browser), so chat stays plain chat. Each Send in this window begins a turn
 * with these choices (lib/turn.ts). The row also starts following this
 * person's waiting questions (lib/questions.ts) for the permission card.
 */
export function AgentRow(props: ComposerProps): JSX.Element {
  const client = useClient();
  void refreshAgents(client);
  watchQuestions(client);
  listenForQueue(client);
  const me = auth.me();
  const shortcuts = useShortcuts();
  const active = useQuery(client, api.turns.active, () => ({ threadId: props.threadId ?? "" }));
  const running = () => activeFor(props.threadId);
  createEffect(
    () => {
      const turn = active.data();
      return turn && client.hasLocal && isSendersDevice(turn, { user: me, device: me.device }) ? turn : null;
    },
    (turn) => {
      localActiveTurn.set(turn);
      return () => {
        if (localActiveTurn() === turn) localActiveTurn.set(null);
      };
    },
  );
  createEffect(
    () => (running()?.stoppingAt === undefined ? running()?._id : undefined),
    (turnId) =>
      turnId ? shortcuts.registerShortcut("escape", () => void stopTurn(client, turnId)) : undefined,
  );
  // The right-hand line while this window's turn runs here.
  const turnLine = () => {
    const turn = running();
    return turn ? (turn.stoppingAt === undefined ? "esc to stop" : "Stopping…") : undefined;
  };
  return (
    <Show
      when={props.threadId}
      fallback={<Row client={client} threadId={undefined} resolved={newThreadChoices} turnLine={turnLine} />}
    >
      {(threadId) => <OpenThreadRow client={client} threadId={threadId()} turnLine={turnLine} />}
    </Show>
  );
}

/**
 * An open thread's row: its stored choices, live; this device's last picks until it has any.
 * Someone who did not start the thread sees only who runs its agent; their Send posts text.
 */
function OpenThreadRow(props: {
  client: TokamakClient;
  threadId: string;
  turnLine: () => string | undefined;
}): JSX.Element {
  const me = auth.me();
  const stored = useQuery(props.client, api.choices.get, () => ({ threadId: props.threadId }));
  const creator = useQuery(props.client, api.choices.creator, () => ({ threadId: props.threadId }));
  onCleanup(
    onTurnDraft(
      props.client,
      () => props.threadId,
      () => creator.data()?.id,
    ),
  );
  const othersThread = () => {
    const started = creator.data();
    return started && started.id !== me.id ? started : undefined;
  };
  const resolved = () => {
    const choices = stored.data();
    return choices ? storedChoices(choices) : deviceChoices();
  };
  return (
    <Show when={!stored.loading() && !creator.loading()}>
      <Show
        when={othersThread()}
        fallback={
          <Row
            client={props.client}
            threadId={props.threadId}
            resolved={resolved}
            turnLine={props.turnLine}
          />
        }
      >
        {(started) => (
          <div role="group" aria-label="Agent" class="flex h-8 shrink-0 items-center px-3">
            <span role="status" class="text-label text-ink-3">
              {creatorOnlyLine(started().name)}
            </span>
          </div>
        )}
      </Show>
    </Show>
  );
}

function Row(props: {
  client: TokamakClient;
  threadId: string | undefined;
  resolved: () => Resolved | undefined;
  turnLine: () => string | undefined;
}): JSX.Element {
  const missing = () => {
    const current = props.resolved();
    return current && unavailable(current.agent);
  };
  // Send waits in this thread's composer while its agent cannot answer.
  onCleanup(holdSend((composer) => composer.threadId === props.threadId && missing() !== undefined));
  const refresh = (open: boolean) => open && void refreshAgents(props.client);
  const change = (current: Resolved, next: Change) =>
    void pick(props.client, props.threadId, current, next).catch((cause: unknown) =>
      notice.set(errorText(cause)),
    );
  return (
    <Show when={props.resolved()}>
      {(current) => (
        // ps-1: the tray's 4 + this 4 + the button's 12 puts the agent mark on the box's text line (4 + 16).
        <div role="group" aria-label="Agent" class="flex h-8 shrink-0 items-center ps-1 pe-3">
          <Picker
            name="Agent"
            options={agents().map((agent) => ({ id: agent.id, label: agent.name }))}
            always
            onOpen={refresh}
            onPick={(id) => {
              const agent = agents().find((entry) => entry.id === id);
              if (agent) change(current(), { agent });
            }}
          >
            <AgentMark agentId={current().agent.id} />
            {current().agent.name}
          </Picker>
          <Show when={!missing()}>
            <Choosers current={current()} refresh={refresh} change={change} />
          </Show>
          <span class="flex-1" />
          <Show when={notice() ?? props.turnLine() ?? missing()}>
            {(line) => (
              <span role="status" class="text-label text-ink-3">
                {line()}
              </span>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

/** The pickers drawn from what the agent offers, in the row's order; each hides when it offers nothing. */
const OFFERED: readonly {
  readonly name: string;
  readonly key: keyof Picked;
  readonly options: (current: Resolved) => readonly { id: string; label: string }[];
  readonly value: (current: Resolved) => string | undefined;
}[] = [
  {
    name: "Model",
    key: "model",
    options: (current) =>
      current.agent.info.models.map((model) => ({
        id: model.id,
        label: modelLabel(current.agent.name, model.name) ?? model.name,
      })),
    value: (current) => modelLabel(current.agent.name, current.model?.name),
  },
  {
    name: "Level",
    key: "effort",
    options: (current) => labelled(current.model?.efforts ?? []),
    value: (current) => current.effort && label(current.effort),
  },
  {
    name: "Speed",
    key: "speed",
    options: (current) => labelled(current.agent.info.speeds),
    value: (current) => current.speed && label(current.speed),
  },
  {
    name: "Mode",
    key: "mode",
    options: (current) => labelled(current.agent.info.modes),
    value: (current) => current.mode && label(current.mode),
  },
];

function labelled(ids: readonly string[]) {
  return ids.map((id) => ({ id, label: label(id) }));
}

/** Model, level, speed, mode and permission level. */
function Choosers(props: {
  current: Resolved;
  refresh: (open: boolean) => void;
  change: (current: Resolved, next: Change) => void;
}): JSX.Element {
  return (
    <>
      <For each={OFFERED}>
        {(picker) => (
          <Show when={picker.value(props.current)}>
            {(value) => (
              <Picker
                name={picker.name}
                options={picker.options(props.current)}
                onOpen={props.refresh}
                onPick={(id) => props.change(props.current, { [picker.key]: id })}
              >
                {/* Plain text: the button owns its text size, weight and tone. A different size
                    inside it sat off its cap-height centring. */}
                {value()}
              </Picker>
            )}
          </Show>
        )}
      </For>
      <Picker
        name="Permission level"
        options={(["full", "ask"] as const).map((id) => ({ id, label: ACCESS_LABEL[id] }))}
        onOpen={props.refresh}
        onPick={(id) => props.change(props.current, { access: id as Access })}
      >
        {ACCESS_LABEL[props.current.access]}
      </Picker>
    </>
  );
}

/**
 * One picker: its current value, opening a menu of the
 * options; with one option, a plain label unless it `always` opens. Its text
 * for screen readers (and tests) is "<name>: <value>", e.g. "Model: opus 5.5".
 */
function Picker(props: {
  name: string;
  options: readonly { id: string; label: string }[];
  /** Opens even with one option (or none): opening asks the agents again. */
  always?: boolean;
  onOpen: (open: boolean) => void;
  onPick: (id: string) => void;
  children: JSX.Element;
}): JSX.Element {
  const value = () => (
    <span class="inline-flex items-center gap-2">
      <span class="sr-only">{props.name}: </span>
      {props.children}
    </span>
  );
  return (
    <Show
      when={props.always || props.options.length > 1}
      fallback={<span class="inline-flex h-8 items-center px-3 text-row text-ink-2">{value()}</span>}
    >
      {/* The standard ghost trigger, untouched: its size owns height and padding. No negative
          margins, so neighbouring hover fills never overlap. */}
      <Menu.Root onOpenChange={props.onOpen} onAction={props.onPick}>
        <Menu.Trigger variant="ghost">{value()}</Menu.Trigger>
        <Menu.Content>
          <For each={props.options}>
            {(option) => <Menu.Item value={option.id}>{option.label}</Menu.Item>}
          </For>
        </Menu.Content>
      </Menu.Root>
    </Show>
  );
}
