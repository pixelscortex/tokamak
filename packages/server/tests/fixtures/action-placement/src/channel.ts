import { action, provide } from "@tokamak/sdk";
import { AGENT_TURN_PROTOCOL, openLocalChannel, type AgentTurnReport } from "@tokamak/sdk/agent-turn";
import { agent } from "./contracts";

export const provider = provide(agent, {
  id: "fixture",
  start: (run) =>
    new Promise((resolve) => {
      run.text("started");
      run.onSteer((text) => run.text(text));
      run.onStop(() => resolve({ sessionId: "fixture", stopped: true }));
    }),
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
