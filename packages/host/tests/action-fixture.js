const action = (invoke) => ({ kind: "action", args: { kind: "any" }, invoke });
let count = 0;
export const functions = {
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
  authority: action((_, host) => ({
    process: typeof globalThis.process,
    proc: typeof host.proc,
  })),
};

functions.hold = action(async (label) => {
  console.info(label);
  await new Promise(() => {});
});
functions.orphanJobs = action(() => {
  function loop() {
    Promise.resolve().then(loop);
  }
  loop();
  return "returned";
});
functions.orphanAllocations = action(() => {
  const retained = [];
  function loop() {
    if (retained.length < 48) {
      retained.push(new Uint8Array(1024 * 1024).fill(1));
    }
    Promise.resolve().then(loop);
  }
  Promise.resolve().then(loop);
  return "returned";
});
functions.heap = action(async () => {
  console.info("heap started");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const retained = [];
  while (true) retained.push(new Uint8Array(64 * 1024).fill(1));
});
