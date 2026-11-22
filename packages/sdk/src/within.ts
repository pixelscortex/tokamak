/** A promise that did not settle in time. */
export const TIMED_OUT: unique symbol = Symbol("timed out");

// Timers exist where waiting makes sense (window, local part); server functions have none to wait on.
const timers = globalThis as unknown as {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

/**
 * Waits at most `ms` for `promise`: its value, or TIMED_OUT once the time is
 * up. The promise keeps running; only the wait ends. For window and local code.
 */
export async function within<T>(promise: PromiseLike<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: unknown;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => (timer = timers.setTimeout(() => resolve(TIMED_OUT), ms))),
    ]);
  } finally {
    timers.clearTimeout(timer);
  }
}
