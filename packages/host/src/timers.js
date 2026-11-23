(() => {
  const wait = globalThis.__schedule;
  const clear = globalThis.__clear;
  delete globalThis.__schedule;
  delete globalThis.__clear;

  let next = 0;
  const timers = new Set();
  const set = (repeat, callback, delay = 0, ...args) => {
    if (typeof callback !== "function") throw new TypeError("Expected a timer callback");
    const id = ++next;
    const ms = Math.max(1, Math.min(2147483647, Number(delay) || 0));
    const fire = () =>
      wait(id, ms).then((fired) => {
        if (!fired || !timers.has(id)) return;
        if (!repeat) timers.delete(id);
        callback(...args);
        if (repeat && timers.has(id)) fire();
      });
    fire();
    timers.add(id);
    return id;
  };

  globalThis.setTimeout = set.bind(null, false);
  globalThis.setInterval = set.bind(null, true);
  globalThis.clearTimeout = globalThis.clearInterval = (id) => {
    if (timers.delete(id)) clear(id);
  };
  // The SDK's local function build also documents an immediate task.
  globalThis.setImmediate = (callback, ...args) => set(false, callback, 0, ...args);
  globalThis.clearImmediate = globalThis.clearTimeout;
  globalThis.TextEncoder = class TextEncoder {
    encode(text = "") {
      return Uint8Array.from(Buffer.from(String(text), "utf8"));
    }
  };
})();
