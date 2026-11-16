import { action, query, v } from "@tokamak/sdk";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { api } from "./_generated/api";
let count = 0;
let releaseLarge: (() => void) | undefined;
let retained: (() => Promise<unknown>) | undefined;
export const state = action({
  handler: () => ({
    count: ++count,
    pid: process.pid,
    cwd: process.cwd(),
    secret: process.env.WORKER_UNGRANTED ?? null,
  }),
});
export const echo = action({
  args: { value: v.string(), delay: v.number() },
  handler: async (_, { value, delay }) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return value;
  },
});
export const roundtrip = action({
  args: { value: v.string() },
  handler: async (ctx, { value }) => {
    const id = await ctx.runMutation(api.database.insert, { value });
    return ctx.runQuery(api.database.get, { id });
  },
});
export const remember = action({
  handler: (ctx) => {
    retained = () => ctx.runQuery(api.database.get, { id: "items/missing" as never });
  },
});
export const stale = action({
  handler: async () => {
    try {
      await retained!();
      return "allowed";
    } catch (error) {
      return String(error);
    }
  },
});
export const crash = action({ handler: () => process.exit(7) });
export const stuck = action({ handler: () => new Promise(() => {}) });
export const cpu = action({
  handler: () => {
    writeFileSync("cpu-started", "");
    for (;;) {}
  },
});
export const flood = action({
  args: { stderr: v.boolean() },
  handler: async (_, { stderr }) => {
    for (let i = 0; i < 4096; i++) {
      if (stderr) process.stderr.write("x".repeat(8192) + "\n");
      else console.log("x".repeat(8192));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return "flooded";
  },
});
export const waitForLarge = action({
  handler: () =>
    new Promise<string>((resolve) => {
      releaseLarge = () => resolve("waiting");
    }),
});
export const large = action({
  handler: async (ctx) => {
    try {
      return await ctx.runQuery(api.database.large, {});
    } finally {
      releaseLarge?.();
    }
  },
});
export const cooperative = action({
  handler: (ctx) =>
    new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true })),
});
export const child = action({
  handler: () => {
    const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    return { worker: process.pid, child: child.pid };
  },
});
export const envDenied = action({ handler: (ctx) => ctx.env("WORKER_UNGRANTED") });
export const dbDenied = action({ handler: (ctx) => (ctx as unknown as { db: unknown }).db ?? null });
// A mixed module must not pull this file's Node actions into QuickJS.
export const pure = query({ handler: () => "QuickJS" });

// Exercise the OS boundary, rather than a JavaScript API wrapper.
export const sandbox = action({
  args: { read: v.string(), write: v.string(), port: v.number() },
  handler: async (_, { read, write, port }) => {
    const { readFileSync } = await import("node:fs");
    const { createConnection } = await import("node:net");
    let readDenied = false;
    let writeDenied = false;
    try {
      readFileSync(read);
    } catch {
      readDenied = true;
    }
    try {
      writeFileSync(write, "escaped");
    } catch {
      writeDenied = true;
    }
    writeFileSync("granted", "inside data");
    const own = readFileSync("granted", "utf8");
    const temp = `${process.env.TMPDIR}/granted`;
    writeFileSync(temp, "inside temp");
    const temporary = readFileSync(temp, "utf8");
    const execDenied = await new Promise<boolean>((resolve) => {
      try {
        const child = spawn("/bin/echo", ["escaped"], { stdio: "ignore" });
        child.on("error", () => resolve(true));
        child.on("exit", (code) => resolve(code !== 0));
      } catch {
        resolve(true);
      }
    });
    const networkDenied = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.on("error", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(true);
      });
    });
    return { readDenied, writeDenied, execDenied, networkDenied, own, temporary };
  },
});
export const granted = action({
  args: { path: v.string() },
  handler: async (_, { path }) => {
    const { readFileSync } = await import("node:fs");
    writeFileSync(`${path}/granted`, "granted path");
    return readFileSync(`${path}/granted`, "utf8");
  },
});
export const pids = action({
  handler: async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const path = readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1];
    // A bounded fork-pressure fixture: stop at 128, clean every child up, and
    // skip only when the host couldn't obtain a delegated cgroup.
    if (!path?.includes("tokamak-worker-")) return { delegated: false, denied: false };
    const children = [];
    let denied = false;
    try {
      for (let i = 0; i < 128; i++) {
        let child;
        try {
          child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
        } catch {
          denied = true;
          break;
        }
        children.push(child);
        const started = await new Promise<boolean>((resolve) => {
          child.on("spawn", () => resolve(true));
          child.on("error", () => resolve(false));
        });
        if (!started) {
          denied = true;
          break;
        }
      }
      return { delegated: true, denied, count: children.length, exists: existsSync("/sys/fs/cgroup") };
    } finally {
      for (const child of children) child.kill();
    }
  },
});
export const descendant = action({
  args: { read: v.string(), write: v.string() },
  handler: (_, { read, write }) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--eval",
          `
      const fs = require("node:fs");
      let readDenied = false, writeDenied = false;
      try { fs.readFileSync(${JSON.stringify(read)}); } catch { readDenied = true; }
      try { fs.writeFileSync(${JSON.stringify(write)}, "escaped"); } catch { writeDenied = true; }
      process.stdout.write(JSON.stringify({readDenied, writeDenied}));
    `,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let text = "";
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout.on("data", (chunk) => {
        text += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code, signal) =>
        code === 0 ? resolve(text) : reject(new Error(`Descendant exited ${code}/${signal}: ${stderr}`)),
      );
    }),
});
