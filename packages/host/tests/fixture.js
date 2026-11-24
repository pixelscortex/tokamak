import fs, { readFile, cp, realpath, unlink } from "node:fs/promises";
import path, { delimiter, join, posix, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

function local(invoke) {
  return { kind: "local", args: { kind: "any" }, invoke };
}

let counter = 0;

export const functions = {
  echo: local((value) => value),
  parseJson: local((text) => JSON.parse(text)),
  pathConstants: local(() => [
    sep,
    delimiter,
    path.sep,
    path.delimiter,
    posix.join("a", "b"),
    path.posix === posix,
    path.posix.posix === posix,
  ]),
  environment: local((name) => ({
    value: process.env[name],
    enumerable: Object.entries(process.env).some(([key]) => key === name),
    missing: process.env.TOKAMAK_UNSET_FIXTURE === undefined,
    node: typeof process.versions.node,
    platform: process.platform,
    ownPath: Object.prototype.hasOwnProperty.call(process.env, "PATH"),
    hasPath: process.env.hasOwnProperty("PATH"),
  })),
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
  flood: local(async () => {
    const line = "x".repeat(8000);
    // More than the 4 MiB output queue holds while nothing reads it.
    for (let i = 0; i < 700; i++) {
      try {
        console.info(line);
      } catch {}
    }
    // Short lines use up the room the long ones left, so not even a result fits.
    for (let i = 0; i < 400; i++) {
      try {
        console.info("");
      } catch {}
    }
    await new Promise(() => {});
  }),
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
    return provider.implementation.run("input");
  }),
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
    console.log("%i %f %O %c tail", "2px", "3.5pt", { nested: [4] }, "color: red");
    console.log(new Date(0), new Map([["key", 1]]), new Set([2]), new Uint8Array([3, 4]));
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

async function programTree(proc, path) {
  const program = proc(["/bin/sh", path, "3"]);
  const lines = program.stdout[Symbol.asyncIterator]();
  const pids = [];
  for (let i = 0; i < 4; i++) {
    const { value, done } = await lines.next();
    if (done) throw new Error("Program tree did not start");
    pids.push(Number(value));
  }
  return { program, pids, lines };
}

Object.assign(functions, {
  graceful: local(async (_, ctx) => {
    const program = ctx.proc([
      "/bin/sh",
      "-c",
      "trap 'echo stopped; exit 42' TERM; echo ready; read -r line",
    ]);
    const output = [];
    for await (const line of program.stdout) {
      output.push(line);
      if (line === "ready") program.stop();
    }
    return [output, await program.exited];
  }),
  scopedTree: local(async (path, ctx) => {
    const outer = ctx.proc(["/bin/cat"]);
    const result = await ctx.withPrograms(async (forceStop, scope) => {
      const { program, pids, lines } = await programTree(scope.proc, path);
      await forceStop();
      return { pids, code: await program.exited, silent: (await lines.next()).done };
    });
    outer.write("outer survived\n");
    outer.closeInput();
    const lines = [];
    for await (const line of outer.stdout) lines.push(line);
    return { ...result, outer: [lines, await outer.exited] };
  }),
  parkTree: local(async (path, ctx) => {
    const { pids } = await programTree(ctx.proc, path);
    console.info("tree", ...pids);
    await new Promise(() => {});
  }),
  longLine: local(async (_, ctx) => {
    const program = ctx.proc([
      "/bin/sh",
      "-c",
      `/usr/bin/awk 'BEGIN { for (i=0; i<=1048576; i++) printf "x"; print "" }'
        echo ready >&2
        read -r line
        echo after-read
        echo "received $line" >&2
        read -r line`,
    ]);
    const outputError = await program.stdout.next().then(
      () => null,
      (error) => error.message,
    );
    const ready = (await program.stderr.next()).value;
    program.write("probe\n");
    const reply = (await program.stderr.next()).value;
    program.stop("SIGKILL");
    return [outputError, ready, reply, await program.exited];
  }),
  inputQueue: local(async (_, ctx) => {
    const program = ctx.proc([
      "/bin/sh",
      "-c",
      "trap 'echo stopped >&2; exit 42' TERM; echo ready >&2; /bin/sleep 30 & wait",
    ]);
    await program.stderr.next();

    const chunk = new Uint8Array(1024 * 1024);
    let accepted = 0;
    let message = null;
    try {
      for (; accepted < 65; accepted++) program.write(chunk);
    } catch (error) {
      message = error.message;
    }
    program.stop();
    return [accepted, message, (await program.stderr.next()).value, await program.exited];
  }),
  immediate: local(async (_, ctx) => {
    const order = [];
    const skipped = setImmediate(() => order.push("cleared"));
    clearImmediate(skipped);
    const io = ctx.op("local.runQuery", {}).then(() => order.push("io"));
    // Let the protocol reader queue the answer before the scheduler runs.
    const end = Date.now() + 75;
    while (Date.now() < end) {}
    const timer = new Promise((resolve) => setTimeout(() => resolve(order.push("timer")), 0));
    const immediate = new Promise((resolve) => setImmediate(() => resolve(order.push("immediate"))));
    Promise.resolve().then(() => order.push("promise"));
    await Promise.all([immediate, timer, io]);
    return order;
  }),
});
