/// <reference lib="dom" />
import { action, v } from "@tokamak/sdk";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function rejected(work: () => unknown, label: string) {
  try {
    await work();
  } catch {
    return;
  }
  throw new Error(`${label}: expected rejection`);
}
async function healthy() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  check(new TextDecoder().decode(new Uint8Array([111, 107])) === "ok", "decoder after cleanup");
  return "healthy";
}

// Exceed the shared 64-slot cap in one invocation: GC/world retirement cannot
// hide a cancelled or errored decoder retaining its native incremental state.
export const decoders = action({
  args: { mode: v.string() },
  handler: async (_ctx, { mode }) => {
    for (let i = 0; i < 130; i++) {
      if (mode === "invalid") {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        decoder.decode(new Uint8Array([0xe2]), { stream: true });
        await rejected(
          () => decoder.decode(null as unknown as Uint8Array, { stream: true }),
          "invalid decoder input",
        );
      } else {
        const decoder = new TextDecoderStream("utf-8", { fatal: true });
        const writer = decoder.writable.getWriter();
        const reader = decoder.readable.getReader();
        if (mode === "error") {
          const read = reader.read();
          const write = writer.write(new Uint8Array([0xff]));
          await rejected(() => write, "fatal decoder write");
          await rejected(() => read, "fatal decoder read");
        } else {
          const read = reader.read();
          await writer.write(new Uint8Array([111, 107]));
          check((await read).value === "ok", `${mode} decoder output ${i}`);
          if (mode === "cancel") await reader.cancel("done");
          else await writer.abort("done");
        }
        writer.releaseLock();
        reader.releaseLock();
      }
    }
    return healthy();
  },
});

// Timer cancellation and throwing delay coercion must not exhaust slots;
// timeout signals must release their timer when they actually fire.
export const timers = action({
  handler: async () => {
    let fired = 0;
    for (let i = 0; i < 130; i++) {
      clearTimeout(
        setTimeout(() => {
          fired++;
        }, 60_000),
      );
      clearInterval(
        setInterval(() => {
          fired++;
        }, 60_000),
      );
      await rejected(
        () =>
          setTimeout(() => {}, {
            valueOf() {
              throw new Error("coercion sentinel");
            },
          } as unknown as number),
        "timer coercion",
      );
      const signal = AbortSignal.timeout(0);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      check(signal.aborted && signal.reason.name === "TimeoutError", "timeout signal did not fire");
    }
    check(fired === 0, "cleared timer fired");
    return healthy();
  },
});

async function typeError(work: () => unknown, label: string) {
  try {
    await work();
  } catch (error) {
    check(error instanceof TypeError, `${label}: expected TypeError, got ${String(error)}`);
    return;
  }
  throw new Error(`${label}: expected TypeError`);
}

// Fetch must transfer a Request's body, even when the first upload completed;
// direct readers must disturb response bodies just like convenience readers.
export const bodies = action({
  args: { url: v.string() },
  handler: async (_ctx, { url }) => {
    const request = new Request(url, { method: "POST", body: "request bytes" });
    const clone = request.clone();
    check(!request.bodyUsed && !clone.bodyUsed, "cloning consumed request");
    check((await (await fetch(request)).text()) === "request bytes", "first POST bytes");
    check(request.bodyUsed, "fetch did not consume original Request");
    await typeError(() => fetch(request), "second POST");
    check((await (await fetch(clone)).text()) === "request bytes", "request clone lost bytes");
    const response = await fetch(url);
    const copy = response.clone();
    check(!response.bodyUsed && !copy.bodyUsed, "cloning consumed response");
    const reader = response.body!.getReader();
    check(new TextDecoder().decode((await reader.read()).value) === "response bytes", "direct reader bytes");
    reader.releaseLock();
    check(response.bodyUsed, "direct read did not disturb response");
    await typeError(() => response.text(), "response reread");
    await typeError(() => response.clone(), "disturbed response clone");
    check((await copy.text()) === "response bytes", "response clone lost bytes");
    return "bodies preserved";
  },
});

// A saved searchParams object must keep its identity and both update directions
// after search/href changes, rather than editing stale pairs into the new URL.
export const params = action({
  handler: () => {
    const url = new URL("https://example.test/old?a=old");
    const params = url.searchParams;
    url.search = "?a=new&a=second&space=hello+world";
    check(params === url.searchParams, "search replaced params identity");
    check(JSON.stringify(params.getAll("a")) === '["new","second"]', "search did not update retained pairs");
    check(params.get("space") === "hello world", "search form decoding");
    params.set("a", "edited");
    check(url.search === "?a=edited&space=hello+world", "retained params did not update search");
    url.href = "https://other.test/new?z=1&z=2#hash";
    check(params === url.searchParams, "href replaced params identity");
    check(!params.has("a") && params.getAll("z").join() === "1,2", "href did not replace retained pairs");
    params.append("z", "3");
    params.delete("z", "1");
    check(url.href === "https://other.test/new?z=2&z=3#hash", "retained params did not update href");
    url.search = "";
    check(params.size === 0, "clearing search retained stale pairs");
    params.append("fresh", "a b");
    check(url.search === "?fresh=a+b", "empty retained params detached");
    return "params live";
  },
});

// A cancelled/erroring reader must free the exchange before the action ends.
export const readers = action({
  args: { url: v.string(), ack: v.string(), mode: v.string() },
  handler: async (_ctx, args) => {
    for (let i = 0; i < 130; i++) {
      const response = await fetch(args.url);
      const reader = response.body!.getReader();
      check(new TextDecoder().decode((await reader.read()).value) === "first", "reader first bytes");
      if (args.mode === "cancel") await reader.cancel("done");
      else {
        await (await fetch(args.ack)).text();
        await rejected(() => reader.read(), "truncated response read");
      }
      reader.releaseLock();
    }
    return healthy();
  },
});

// Failed/short-circuited uploads must cancel their native fetch source too;
// merely freeing the destination exchange still leaks one source per cycle.
export const uploads = action({
  args: { source: v.string(), target: v.string(), mode: v.string() },
  handler: async (_ctx, args) => {
    for (let i = 0; i < 130; i++) {
      const source = await fetch(args.source);
      const init: RequestInit = { method: "POST", body: source.body };
      if (args.mode === "abort") init.signal = AbortSignal.abort();
      if (args.mode === "early") {
        const response = await fetch(args.target, init);
        check(response.status === 204, "early upload response");
      } else await rejected(() => fetch(args.target, init), "upload termination");
      // Drain scheduled cancellation before the next native allocation.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return healthy();
  },
});

// Deliberately leave all resource classes alive: native retirement, rather
// than JS finally blocks or GC, must release them on every invocation exit.
export const abandoned = action({
  args: { url: v.string(), mode: v.string() },
  handler: async (_ctx, { url, mode }) => {
    const response = await fetch(url);
    const reader = response.body!.getReader();
    check(new TextDecoder().decode((await reader.read()).value) === "first", "abandoned first bytes");
    void reader.read().catch(() => {});
    for (let i = 0; i < 15; i++) {
      const decoder = new TextDecoder();
      decoder.decode(new Uint8Array([0xe2]), { stream: true });
      setTimeout(() => {}, 60_000);
      AbortSignal.timeout(60_000);
    }
    if (mode === "throw") throw new Error("abandon sentinel");
    if (mode === "cancel") {
      await (await fetch(new URL("/ready", url))).text();
      await new Promise<never>(() => {});
    }
    return "abandoned";
  },
});

// Native cancellation must progress even while JS occupies the worker thread.
export const abortBusy = action({
  args: { url: v.string(), ack: v.string() },
  handler: async (_ctx, { url, ack }) => {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    void reader.read().catch(() => {});
    await (await fetch(ack)).text();
    controller.abort();
    const until = Date.now() + 500;
    while (Date.now() < until) {
      /* Hold JS without polling native promises. */
    }
    return Date.now();
  },
});
