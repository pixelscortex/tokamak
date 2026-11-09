// Finite CPU work crosses clock ticks without sleeps or a live-clock busy wait.
export function sample() {
  const now = Date.now();
  const random = [Math.random(), Math.random(), Math.random()];
  let work = 0;
  for (let i = 0; i < 200_000; i++) work = Math.imul(work ^ i, 1664525) | 0;
  return { now, later: Date.now(), constructed: new Date().getTime(),
    text: Date(), explicit: new Date(1234).getTime(), random, work };
}
