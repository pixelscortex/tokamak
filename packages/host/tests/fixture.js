import fs, { readFile, cp, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

function local(invoke) {
  return { kind: "local", args: { kind: "any" }, invoke };
}

let counter = 0;

export const functions = {
  echo: local((value) => value),
  loop: local(async () => {
    console.info("loop");
    while (true) {}
  }),
  memory: local(() => {
    const objects = [];
    for (;;) objects.push({ a: objects.length, b: objects.length, c: objects.length });
  }),
  busy: local(() => {
    console.info("busy");
    const end = Date.now() + 1500;
    while (Date.now() < end) {}
    return "finished";
  }),
  sleep: local(async (delay) => {
    counter++;
    await new Promise((resolve) => setTimeout(resolve, delay).unref().ref());
    return "slept";
  }),
  counter: local(() => counter),
  pending: local(async (_, ctx) => {
    ctx.signal.addEventListener("abort", () => {
      console.info("signal aborted");
      throw new Error("abort listener failed");
    });
    try {
      await ctx.op("local.runQuery", {});
    } catch (error) {
      console.info(error.message);
    }
    try {
      await ctx.op("local.runQuery", {});
    } catch (error) {
      console.info(error.message);
    }
    return "late result";
  }),
  providers: local(async (_, ctx) => {
    const [provider] = await ctx.contracts.list({ place: "local", owner: "consumer", name: "fixture" });
    const input = {
      callback(id, file) {
        return { same: this === input, id, file };
      },
    };
    return provider.implementation.run(input);
  }),
  unapproved: local((path) => import(path)),
  timerCapacity: local(async () => {
    let armed;
    const rearm = new Promise((resolve) => {
      armed = resolve;
    });
    const timers = [];
    const interval = setInterval(() => {
      timers.push(setTimeout(() => {}, 60000));
      armed();
    }, 10);
    let error;
    try {
      for (let i = 0; i < 4095; i++) timers.push(setTimeout(() => {}, 60000));
      try {
        setTimeout(() => {}, 60000);
      } catch (cause) {
        error = cause.message;
      }
      await rearm;
      return error;
    } finally {
      timers.forEach(clearTimeout);
      clearInterval(interval);
    }
  }),
  console: local(() => {
    console.log("%s %d %j %o", "value", "2", { a: 1 }, [3, 4]);
    console.dir({ outer: [1, 2] });
    console.trace("test");
    console.warn(new Error("broken"));
    console.debug("x".repeat(9000));
    return true;
  }),
  missing: local(async (path) => {
    const errors = [];
    for (const op of [readFile, fs.lstat, unlink]) {
      try {
        await op(path);
      } catch (error) {
        errors.push([error.code, error.path]);
      }
    }
    return errors;
  }),
  filesystem: local(async (raw) => {
    const dir = await fs.mkdtemp(join(tmpdir(), "tokamak-fs-"));
    const from = join(dir, "from");
    const to = join(dir, "to");
    const bytes = Buffer.concat([Buffer.from(from + "/"), Uint8Array.from(raw)]);
    try {
      await fs.mkdir(from, { recursive: true });
      await fs.writeFile(bytes, "raw path", { mode: 0o600 });
      const file = join(from, "original");
      await fs.writeFile(file, "target", { mode: 0o600 });
      await fs.rename(file, join(from, "target"));
      await fs.symlink("target", join(from, "link"));
      await fs.cp(from, to, { recursive: true, preserveTimestamps: true });
      const followed = join(dir, "followed");
      await fs.cp(join(from, "link"), followed, { dereference: true });
      await fs.cp(join(from, "link"), followed, { force: false });
      const exists = await fs
        .cp(join(from, "link"), followed, { force: false, errorOnExist: true })
        .catch((error) => error.code);
      const unlinkDir = await fs.unlink(from).catch((error) => error.code);
      const rawCopy = Buffer.concat([Buffer.from(to + "/"), Uint8Array.from(raw)]);
      const fdPath = Buffer.from(join(to, "target"));
      const handle = await fs.open(fdPath, "r");
      const opened = await handle.readFile("utf8");
      await handle.close();
      return {
        path: await readFile(rawCopy, "utf8"),
        mode: (await fs.lstat(rawCopy)).mode & 0o777,
        symlink: (await fs.lstat(join(to, "link"))).isSymbolicLink(),
        contents: await readFile(join(to, "link"), "utf8"),
        followed: (await fs.lstat(followed)).isFile(),
        names: (await fs.readdir(from)).length,
        mtime: (await fs.stat(join(to, "target"))).mtimeMs === (await fs.stat(join(from, "target"))).mtimeMs,
        exists,
        unlinkDir,
        opened,
      };
    } finally {
      await fs.rm(dir, { force: true, recursive: true });
    }
  }),
  huge: local(() => "x".repeat(1024 * 1024)),
  native: local(async ({ source, endpoint }) => {
    const file = join(tmpdir(), randomUUID());
    await cp(source, file);
    try {
      const path = await realpath(pathToFileURL(file));
      const text = await readFile(path, "utf8");
      let ticks = 0;
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          clearInterval(timer);
          ticks++;
          resolve();
        }, 1);
      });
      const bytes = new TextEncoder().encode("ε");
      return {
        copied: text.includes("export const functions"),
        text: await (await fetch(endpoint)).text(),
        bytes: [...bytes],
        ticks,
        decoded: new TextDecoder().decode(bytes),
      };
    } finally {
      await unlink(file);
    }
  }),
};
