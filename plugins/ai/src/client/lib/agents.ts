import { isFailure, type TokamakClient } from "@tokamak/sdk";
import { state } from "@tokamak/sdk/client";
import type { Info } from "../../contracts";
import { setupReason } from "../../shared/turn-shared";
import { api } from "../../server/_generated/api";

export { api };

export interface AgentEntry {
  readonly id: string;
  readonly name: string;
  /** The agent's mark as its plugin gave it (an SVG document); see `Agent.icon`. */
  readonly icon?: string;
  readonly info: Info;
}

/** Installed agents as this computer's local part last answered; empty in a plain browser. */
export const agents = state<readonly AgentEntry[]>([]);

/** A short line the row shows after a turn could not begin; cleared by the next Send. */
export const notice = state<string | undefined>(undefined);

export const machineNotice = state<string | undefined>(undefined);

let asking: Promise<void> | undefined;
let queued: Promise<void> | undefined;
let connected: TokamakClient | undefined;

/** This window's connection, as the row or the heading last saw it; turns run through it. */
export function connectedClient(): TokamakClient | undefined {
  return connected;
}

/**
 * Asks every agent plugin for its `info` again, on this computer. Called
 * whenever the row or the heading appears and whenever a picker opens, so a
 * fresh install or sign-in shows without a restart. An ask already on its way
 * may have started before the change, so a call meanwhile asks once more after
 * it (several such calls share that one).
 */
export function refreshAgents(client: TokamakClient): Promise<void> {
  connected = client;
  if (asking) {
    queued ??= asking.then(() => {
      queued = undefined;
      return refreshAgents(client);
    });
    return queued;
  }
  asking = client
    .action(api.agents.list, {})
    .then(
      (list) => {
        if (connected !== client) return;
        machineNotice.set(isFailure(list) ? reasonLine(list.kind, "") : undefined);
        agents.set(isFailure(list) ? [] : list);
      },
      () => void agents.set([]),
    )
    .finally(() => {
      asking = undefined;
    });
  return asking;
}

/** Why a turn cannot run or begin, as `run:turn` fails or the row sees it. */
export type Reason =
  | "NoAgent"
  | "NotInstalled"
  | "SignedOut"
  | "Busy"
  | "Answered"
  | "noMachine"
  | "runnerCapabilityUnavailable";

/** The row's line for `reason`, naming the agent as a person sees it. */
export function reasonLine(reason: Reason, agent: string, updateRequired?: string): string {
  switch (reason) {
    case "noMachine":
      return "Connect a machine to run this";
    case "runnerCapabilityUnavailable":
      return "This machine cannot run this action.";
    case "NotInstalled":
      return updateRequired ?? `${agent} isn't installed.`;
    case "SignedOut":
      return `${agent} is signed out. Sign in, then come back.`;
    case "Busy":
      return `${agent} is still working in this thread.`;
    case "Answered":
      return `${agent} already answered this message.`;
    case "NoAgent":
      return `${agent} is no longer installed.`;
  }
}

/** Why Send cannot reach `agent` now, in the row's words; undefined when it can. */
export function unavailable(agent: AgentEntry): string | undefined {
  return setupReason(agent.name, agent.info, false);
}

/**
 * A model's name as people read it, without the agent's name in front:
 * "Claude Fable 5.2" under Claude is "Fable 5.2". Turns from before Claude
 * named its default by the model stored "Default (recommended)": that reads
 * "Default", since which model it was then is not known.
 */
export function modelLabel(agentName: string | undefined, name: string | undefined): string | undefined {
  const model = name?.replace(/^(default)\s*\(recommended\)$/i, "$1");
  if (!model) return undefined;
  if (!agentName) return model;
  const prefix = `${agentName} `;
  return model.toLowerCase().startsWith(prefix.toLowerCase()) && model.length > prefix.length
    ? model.slice(prefix.length)
    : model;
}
