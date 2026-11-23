const action = (invoke) => ({ kind: "action", args: { kind: "any" }, invoke });
let count = 0;
export const functions = {
  delay: action(async (ms) => {
    console.info("delay started");
    await new Promise((resolve) => setTimeout(resolve, ms));
    return "done";
  }),
  count: action(() => ++count),
  loop: action(() => {
    console.info("loop started");
    while (true) {}
  }),
  heap: action(() => "x".repeat(30_000_000)),
  authority: action((_, host) => ({
    process: typeof globalThis.process,
    proc: typeof host.proc,
  })),
};
