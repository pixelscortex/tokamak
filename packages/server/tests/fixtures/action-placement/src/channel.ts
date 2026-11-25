import { action, provide } from "@tokamak/sdk";
import {
  AGENT_TURN_PROTOCOL,
  openLocalChannel,
  type AgentTurnReport,
  type Run,
  type TurnResult,
} from "@tokamak/sdk/agent-turn";
import { agent } from "./contracts";
import { api } from "./_generated/api";

let observedAborts = 0;

export const provider = provide(agent, {
  id: "fixture",
  start: action({
    on: "caller",
    handler: async (ctx, run: Run) => {
      if ((await ctx.env("FIXTURE_ACTION_PLACEMENT")) !== "on this machine")
        throw new Error("Missing caller action environment in the provider");
      return new Promise<TurnResult>((resolve) => {
        run.text("started");
        run.onSteer((text) => run.text(text));
        run.onStop(() => resolve({ sessionId: "fixture", stopped: true }));
      });
    },
  }),
  wait: action({
    on: "caller",
    handler: async (ctx, { signal }: { signal: AbortSignal }) => {
      const aborted = new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAborts++;
            resolve();
          },
          { once: true },
        );
      });
      await ctx.runMutation(api.work.store, { text: "provider waiting on live signal" });
      await aborted;
    },
  }),
  signalCount: action({ on: "caller", handler: () => observedAborts }),
});

export const stream = action({
  on: "caller",
  handler: async (ctx) => {
    const provider = await agent.get("fixture", ctx);
    if (!provider) throw new Error("Fixture provider missing");

    const address = { threadId: "chat/threads:fixture", turnId: "fixture" };
    const received: string[] = [];
    let ready!: () => void;
    const listening = new Promise<void>((resolve) => (ready = resolve));
    const channel = openLocalChannel(
      provider,
      "start",
      {
        ...address,
        version: AGENT_TURN_PROTOCOL,
        folder: ".",
        history: [],
        model: "",
        prompt: "",
        access: "full",
      },
      (method, value) => {
        if (method !== "report") throw new Error(`Unexpected message ${method}`);
        const { events } = value as unknown as AgentTurnReport;
        for (const event of events) {
          if (event.kind === "text") received.push(event.value);
          if (event.kind === "steerReady") ready();
        }
        return null;
      },
    );
    if (!channel) throw new Error("Fixture channel missing");
    try {
      await Promise.race([listening, channel.result]);
      await channel.send("steer", { ...address, text: "steered" });
      await channel.send("stop", address);
      return { result: await channel.result, received };
    } finally {
      await channel.close();
    }
  },
});

export const liveSignal = action({
  on: "caller",
  handler: async (ctx) => {
    const input = new AbortController();
    const provider = await agent.get("fixture", ctx, { signal: ctx.signal, inputSignal: input.signal });
    if (!provider) throw new Error("Fixture provider missing");
    return provider.wait({ signal: input.signal });
  },
});

export const signalCount = action({
  on: "caller",
  handler: (ctx) => agent.get("fixture", ctx).signalCount(),
});
