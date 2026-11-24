import type { LocalContext } from "@tokamak/sdk";
import { openLocalChannel } from "@tokamak/sdk/agent-turn";
import type {
  AgentTurnAsk,
  AgentTurnReport,
  AgentTurnStart,
  TurnAddress,
  TurnResult,
} from "@tokamak/sdk/agent-turn";
import { agent, type Agent, type Run } from "../contracts";
import type { turnControl } from "./controls";

type Questions = Pick<Run, "ask"> & { cancel(): Promise<void>; expire(): void };
type Control = ReturnType<typeof turnControl>;
type Reports = Pick<
  Run,
  "text" | "thinking" | "plan" | "tasks" | "tool" | "helper" | "usage" | "sessionChanged"
>;

function channelEnded(error: unknown): boolean {
  return error instanceof Error && error.message === "Local contract channel ended";
}

export function runAgent(
  ctx: LocalContext,
  provider: Agent,
  request: AgentTurnStart,
  reports: Reports,
  questions: Questions,
  control: Control,
) {
  const linked = startAgent(provider, request, reports, questions, control);
  if (linked) return linked;

  const { threadId: _thread, turnId: _turn, ...input } = request;
  return ctx.withPrograms((kill, scoped) =>
    control.run(
      () =>
        // Bun gives the live Run to the provider in ai's worker.
        agent.get(provider.id, scoped).start({
          ...input,
          ...reports,
          ask: questions.ask,
          onSteer: control.onSteer,
          onStop: control.onStop,
        }),
      kill,
    ),
  );
}

/** A linked start owns every message of one turn, even across an agent reload. */
export function startAgent(
  provider: Agent,
  request: AgentTurnStart,
  reports: Reports,
  questions: Questions,
  control: Control,
) {
  const { threadId, turnId } = request;
  const address: TurnAddress = { threadId, turnId };
  let accepting = true;
  const channel = openLocalChannel(provider, "start", request, async (method, value) => {
    const target = value as unknown as TurnAddress;
    if (!accepting || target?.threadId !== threadId || target.turnId !== turnId)
      return method === "ask" ? "cancel" : null;
    switch (method) {
      case "ask":
        return questions.ask((value as unknown as AgentTurnAsk).question);
      case "report":
        applyReports((value as unknown as AgentTurnReport).events, reports, () =>
          control.onSteer(async (text) => {
            await channel!.send("steer", { ...address, text });
          }),
        );
        return null;
      default:
        throw new Error(`Unknown agent turn message: ${method}`);
    }
  });
  if (!channel) return undefined;

  control.onStop(async () => {
    await channel.send("stop", { ...address });
  });
  let forcing = false;
  let ended = false;
  const result = channel.result
    .then(
      (value) => value as unknown as TurnResult,
      (error: unknown) => {
        if (!forcing) throw error;
        return undefined;
      },
    )
    .finally(() => {
      ended = true;
      accepting = false;
      questions.expire();
    });
  return control.run(
    () => result,
    async () => {
      forcing = true;
      accepting = false;
      await questions.cancel();
      if (ended) return;
      try {
        await channel.send("forceStop", { ...address });
      } catch (error) {
        // The turn may have settled naturally just before it accepted Force stop.
        if (channelEnded(error)) {
          await result;
          return;
        }
        if (!ended) throw error;
      }
      await channel.close().catch((error: unknown) => {
        if (!channelEnded(error)) throw error;
      });
    },
  );
}

function applyReports(events: AgentTurnReport["events"], reports: Reports, steerReady: () => void) {
  for (const event of events) {
    switch (event.kind) {
      case "text":
        reports.text(event.value);
        break;
      case "thinking":
        reports.thinking(event.value);
        break;
      case "plan":
        reports.plan(event.value);
        break;
      case "tasks":
        reports.tasks(event.value);
        break;
      case "tool":
        reports.tool(event.value);
        break;
      case "helper":
        reports.helper(event.value);
        break;
      case "usage":
        reports.usage(event.value);
        break;
      case "session":
        reports.sessionChanged(event.value ?? undefined);
        break;
      case "steerReady":
        steerReady();
        break;
    }
  }
}
