const action = (invoke) => ({ kind: "action", args: { kind: "any" }, invoke });
let count = 0;
export const functions = {
  delay: action(async (ms) => {
    console.info("delay started");
    await new Promise((resolve) => setTimeout(resolve, ms));
    return "done";
  }),
  spin: action((ms) => {
    console.info("spin started");
    const end = Date.now() + ms;
    while (Date.now() < end) {}
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
