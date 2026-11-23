(() => {
  const wait = globalThis.__schedule;
  const clear = globalThis.__clear;
  const logger = globalThis.console;
  delete globalThis.__schedule;
  delete globalThis.__clear;

  let next = 0;
  const handles = new WeakMap();
  const timers = new Set();
  const set = (repeat, callback, delay = 0, ...args) => {
    if (typeof callback !== "function") throw new TypeError("Expected a timer callback");
    const id = ++next;
    const ms = Math.max(1, Math.min(2147483647, Number(delay) || 0));
    const fire = () => {
      // Keep the first scheduling error synchronous so callers can catch a full timer queue.
      void wait(id, ms)
        .then((fired) => {
          if (!fired || !timers.has(id)) return;
          if (!repeat) timers.delete(id);
          callback(...args);
          if (repeat && timers.has(id)) fire();
        })
        .catch((error) => {
          timers.delete(id);
          logger.error(error);
        });
    };
    fire();
    timers.add(id);
    const handle = {
      ref() {
        return this;
      },
      unref() {
        return this;
      },
      [Symbol.toPrimitive]() {
        return id;
      },
    };
    handles.set(handle, id);
    return handle;
  };

  globalThis.setTimeout = set.bind(null, false);
  globalThis.setInterval = set.bind(null, true);
  globalThis.clearTimeout = globalThis.clearInterval = (handle) => {
    const id = typeof handle === "number" ? handle : handles.get(handle);
    if (timers.delete(id)) clear(id);
  };
  globalThis.setImmediate = (callback, ...args) => set(false, callback, 0, ...args);
  globalThis.clearImmediate = globalThis.clearTimeout;
})();
