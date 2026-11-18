import { v, type DatabaseWriter, type DatabaseReader, type Id, type Doc } from "@tokamak/sdk";
import { mutation, query, type Model } from "../_functions";
import { interruptResponse } from "../runs/run-messages";

const LEASE_MS = 15_000;
export const offline =
  "Your machine is not connected or has no agents. Open Tokamak on your machine and try again.";

export async function liveMachines(db: DatabaseReader<Model>, owner: string) {
  return (
    await db
      .query("machines")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .collect()
  ).filter((m) => m.leaseUntil > Date.now());
}

async function interrupt(db: DatabaseWriter<Model>, run: Doc<Model, "runs">) {
  await interruptResponse(db, run, "error", "Interrupted: machine disconnected");
  await db.patch(run._id, {
    status: "error",
    error: "Interrupted: machine disconnected",
    token: null,
    waiting: false,
    finishedAt: Date.now(),
  });
  await db.patch(run.threadId, { updatedAt: Date.now() });
}

export const register = mutation({
  args: {
    machineId: v.string(),
    name: v.string(),
    epoch: v.string(),
    agents: v.array(v.object({ id: v.string(), title: v.string() })),
  },
  handler: async ({ db, user }, args) => {
    if (!args.machineId || args.machineId.length > 200 || !args.epoch || args.agents.length > 64)
      throw new Error("Invalid machine registration");
    const previous = (
      await db
        .query("machines")
        .withIndex("by_owner", (q) => q.eq("owner", user.id))
        .collect()
    ).find((m) => m.machineId === args.machineId);
    if (previous) {
      if (previous.epoch !== args.epoch || previous.leaseUntil <= Date.now()) {
        for (const work of await db
          .query("work")
          .withIndex("by_machine", (q) => q.eq("machine", previous._id))
          .collect()) {
          const run = await db.get(work.runId);
          if (run?.status === "running") await interrupt(db, run);
          if (work.status !== "finished") await db.patch(work._id, { status: "finished" });
        }
      }
      await db.patch(previous._id, { ...args, leaseUntil: Date.now() + LEASE_MS });
      return previous._id;
    }
    return db.insert("machines", { ...args, owner: user.id, leaseUntil: Date.now() + LEASE_MS });
  },
});

async function owned(db: DatabaseReader<Model>, owner: string, machine: Id<"machines">, epoch: string) {
  const value = await db.get(machine);
  if (!value || value.owner !== owner || value.epoch !== epoch || value.leaseUntil <= Date.now())
    throw new Error("Machine lease expired");
  return value;
}

export const heartbeat = mutation({
  args: {
    machine: v.id("machines"),
    epoch: v.string(),
    agents: v.optional(v.array(v.object({ id: v.string(), title: v.string() }))),
  },
  handler: async ({ db, user }, { machine, epoch, agents }) => {
    await owned(db, user.id, machine, epoch);
    if (agents && agents.length > 64) throw new Error("Too many agents");
    await db.patch(machine, { leaseUntil: Date.now() + LEASE_MS, ...(agents ? { agents } : {}) });
    return null;
  },
});

export const disconnect = mutation({
  args: { machine: v.id("machines"), epoch: v.string() },
  handler: async ({ db, user }, { machine, epoch }) => {
    const current = await db.get(machine);
    if (current?.owner !== user.id || current.epoch !== epoch)
      throw new Error("Machine does not belong to you");
    await db.patch(machine, { leaseUntil: 0 });
    return null;
  },
});

export const agents = query({
  handler: async ({ db, user }) => {
    const found = new Map<string, { id: string; title: string; plugin: string; folder: boolean }>();
    for (const machine of await liveMachines(db, user.id))
      for (const agent of machine.agents) found.set(agent.id, { ...agent, plugin: "acp", folder: false });
    return [...found.values()];
  },
});

export const pending = query({
  args: { machine: v.id("machines"), epoch: v.string() },
  handler: async ({ db, user }, { machine, epoch }) => {
    await owned(db, user.id, machine, epoch);
    return (
      await db
        .query("work")
        .withIndex("by_machine", (q) => q.eq("machine", machine))
        .collect()
    )
      .filter((w) => w.epoch === epoch && w.owner === user.id && w.status === "queued")
      .map((w) => w._id);
  },
});

export const claim = mutation({
  args: { machine: v.id("machines"), epoch: v.string(), workId: v.id("work"), token: v.string() },
  handler: async ({ db, user }, { machine, epoch, workId, token }) => {
    const current = await owned(db, user.id, machine, epoch);
    const work = await db.get(workId);
    if (!work || work.owner !== user.id || work.machine !== machine || work.epoch !== epoch)
      throw new Error("Work does not belong to your machine");
    const run = await db.get(work.runId);
    if (work.status !== "queued") return null;
    if (run?.status !== "running") {
      await db.patch(workId, { status: "finished" });
      return null;
    }
    if (!current.agents.some((a) => a.id === work.backendId) || token.length < 32)
      throw new Error("Invalid machine claim");
    await db.patch(workId, { status: "claimed" });
    await db.patch(run._id, { token, updatedAt: Date.now() });
    return {
      ...work,
      runId: run._id,
      threadId: run.threadId,
      messageId: run.messageId,
      token,
      owner: { id: user.id, name: user.name },
      machineName: current.name,
    };
  },
});

// Runs on the server timer, including when every window is closed. No replay.
export const expire = mutation({
  handler: async ({ db }) => {
    const now = Date.now();
    const running = await db
      .query("runs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
    for (const run of running) {
      if (run.machine) {
        const machine = await db.get(run.machine);
        if (machine && machine.leaseUntil > now && machine.epoch === run.machineEpoch) continue;
        await interrupt(db, run);
      } else if (now - (run.updatedAt ?? run.startedAt) > 60_000) {
        await interruptResponse(db, run, "error", "Interrupted");
        await db.patch(run._id, {
          status: "error",
          error: "Interrupted",
          token: null,
          waiting: false,
          finishedAt: now,
        });
        await db.patch(run.threadId, { updatedAt: now });
      } else continue;
      for (const work of await db
        .query("work")
        .withIndex("by_runId", (q) => q.eq("runId", run._id))
        .collect())
        await db.patch(work._id, { status: "finished" });
    }
    // Invalidate the agent live query when leases lapse (time alone is not a DB change).
    for (const machine of await db.query("machines").collect())
      if (machine.leaseUntil > 0 && machine.leaseUntil <= now) await db.patch(machine._id, { leaseUntil: 0 });
    return null;
  },
});
