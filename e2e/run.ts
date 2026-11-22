import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TokamakClient, WebSocketTransport, createApi } from "../packages/sdk/src/index";
import type { ApiFromModule, SubscriptionEvent } from "../packages/sdk/src/index";
const api = createApi<{
  record: ApiFromModule<typeof import("../packages/server/tests/fixtures/record/src/server/record")>;
}>();
import { buildFeature } from "../packages/server/tests/build-feature.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
process.chdir(repository);
const env = { ...process.env, CARGO_BUILD_JOBS: "2", RAYON_NUM_THREADS: "2" };

function command(args: string[], extra: Record<string, string> = {}) {
  const child = spawnSync(args[0], args.slice(1), {
    cwd: repository,
    env: { ...env, ...extra },
    stdio: "inherit",
    timeout: 3_600_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `${args.join(" ")} failed (${child.signal ?? "exit"})`);
}

async function bounded<T>(promise: Promise<T>, label: string, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${ms}ms; mutation outcomes may be unknown`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function headless(
  bundle: string,
  data: string,
  check: (address: string, child: ReturnType<typeof spawn>) => Promise<void>,
  options: { args?: string[]; env?: NodeJS.ProcessEnv; timeout?: number; killed?: boolean } = {},
) {
  const child = spawn(
    resolve("target/debug/tokamak-server"),
    [...(options.args ?? ["--bundle", bundle]), "--data", data, "--listen", "127.0.0.1:0", "--workers", "1"],
    { cwd: repository, env: { ...env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let ready!: (address: string) => void;
  let failed!: (error: Error) => void;
  const readiness = new Promise<string>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const capture = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 1_048_576) {
      failed(new Error("headless output exceeded 1 MiB"));
      child.kill("SIGKILL");
    }
    const match = output.match(/Tokamak listening on (ws:\/\/127\.0\.0\.1:\d+\/ws)/);
    if (match) ready(match[1]);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      failed(error);
      resolve(null);
    });
    child.once("exit", (code, signal) => {
      failed(new Error(`headless exited before readiness: ${code}/${signal}\n${output}`));
      resolve(code);
    });
  });
  try {
    // A real bound address emitted AFTER Backend::start is the startup barrier.
    const address = await bounded(readiness, "headless readiness");
    await bounded(check(address, child), "headless scenario", options.timeout ?? 45_000);
  } catch (error) {
    throw new Error(`${String(error)}\nheadless output:\n${output}`, { cause: error });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try {
      const code = await bounded(exited, "headless graceful shutdown", 25_000);
      if (!options.killed || child.signalCode !== "SIGKILL") assert.equal(code, 0, output);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await bounded(exited, "headless forced cleanup", 5_000);
      }
    }
  }
}

export async function connect(address: string, token?: string) {
  const url = new URL(address);
  const socket = new WebSocket(
    url,
    token ? ["tokamak", `tokamak.bearer.${encodeURIComponent(token)}`] : undefined,
  );
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket startup error")), { once: true });
        socket.addEventListener("close", () => reject(new Error("WebSocket closed during startup")), {
          once: true,
        });
      }),
      "WebSocket connect",
    );
    const transport = new WebSocketTransport(socket);
    return { transport, client: new TokamakClient(transport) };
  } catch (error) {
    socket.close();
    throw error;
  }
}

type Rows = Awaited<ReturnType<RecordRead>>;
type RecordRead = () => Promise<Array<{ _id: string; _creationTime: number; title: string; done: boolean }>>;

function observer(client: TokamakClient) {
  let latest: Rows | undefined;
  let failure: Error | undefined;
  const pending = new Set<{
    predicate: (rows: Rows) => boolean;
    resolve: (rows: Rows) => void;
    reject: (error: Error) => void;
  }>();
  const stop = client.subscribe(api.record.list, {}, (event: SubscriptionEvent<Rows>) => {
    if ("error" in event) failure = event.error;
    else latest = event.value;
    for (const waiter of pending) {
      if (failure) waiter.reject(failure);
      else if (latest && waiter.predicate(latest)) waiter.resolve(latest);
    }
  });
  return {
    stop,
    async until(predicate: (rows: Rows) => boolean) {
      if (failure) throw failure;
      if (latest && predicate(latest)) return latest;
      let waiter!: {
        predicate: typeof predicate;
        resolve: (rows: Rows) => void;
        reject: (error: Error) => void;
      };
      const result = new Promise<Rows>((resolve, reject) => {
        waiter = { predicate, resolve, reject };
        pending.add(waiter);
      });
      try {
        return await bounded(result, "subscription result");
      } finally {
        pending.delete(waiter);
      }
    },
  };
}

await mkdir("target/e2e", { recursive: true });
const root = await mkdtemp(resolve("target/e2e/run-"));
let feature: string | undefined;
try {
  command([process.execPath, "check", "--no-script", "--project", "e2e/tsconfig.json"]);
  command(["cargo", "build", "--locked", "--package", "server", "--bin", "tokamak-server", "--jobs", "2"]);
  feature = await buildFeature({
    source: resolve("packages/server/tests/fixtures/record/src/server"),
    parent: root,
  });
  const bundle = join(feature, "dist/bundle.js");
  const store = join(root, "store");
  let expected: Rows = [];
  await headless(bundle, store, async (address) => {
    const { client, transport } = await connect(address);
    try {
      const id = await client.mutation(api.record.add, { title: "persist across server restart" });
      await client.mutation(api.record.toggle, { id });
      expected = await client.query(api.record.list, {});
      assert.equal(expected[0]?.done, true);
    } finally {
      transport.close();
    }
  });
  // Scenarios 2/4: two separate SDKs, sockets and server sessions; BOTH actually
  // subscribe before either writes. Full equality proves the persisted data path.
  await headless(bundle, store, async (address) => {
    const first = await connect(address);
    try {
      const second = await connect(address);
      try {
        assert.deepEqual(await first.client.query(api.record.list, {}), expected);
        const a = observer(first.client);
        const b = observer(second.client);
        try {
          assert.deepEqual(await a.until(() => true), expected);
          assert.deepEqual(await b.until(() => true), expected);
          const id = await first.client.mutation(api.record.add, { title: "independent client live sync" });
          const received = await b.until((rows) => rows.some((row) => row._id === id));
          assert.deepEqual(await a.until((rows) => rows.some((row) => row._id === id)), received);
          assert.equal(received.find((row) => row._id === id)?.title, "independent client live sync");
          assert(received.some((row) => row._id === expected[0]._id));
        } finally {
          a.stop();
          b.stop();
        }
      } finally {
        second.transport.close();
      }
    } finally {
      first.transport.close();
    }
  });
  console.log("PASS scenarios 2/3/4: independent subscribers + server close/reopen + exact persisted data");

  feature = await buildFeature({ source: resolve("e2e/feature"), parent: root });
  const budgetApi = createApi<{ budget: ApiFromModule<typeof import("./feature/budget")> }>();
  // Scenario 5: one worker means recovery cannot hide behind another healthy
  // worker. Require a runtime budget diagnostic, not a socket/client timeout.
  await headless(
    join(feature, "dist/bundle.js"),
    join(root, "budget-store"),
    async (address) => {
      const { client, transport } = await connect(address);
      try {
        await assert.rejects(
          bounded(client.mutation(budgetApi.budget.endless, {}), "endless mutation", 5_000),
          /wall-clock budget/,
        );
        assert.equal(
          await bounded(client.mutation(budgetApi.budget.healthy, {}), "next mutation", 5_000),
          "next mutation succeeded",
        );
      } finally {
        transport.close();
      }
    },
    { args: ["--bundle", join(feature, "dist/bundle.js"), "--call-ms", "100"] },
  );
  console.log(
    "PASS scenario 5: CPU loop interrupted by runtime budget; next real service mutation succeeded",
  );
} finally {
  // headless always reaps the child before removing its own exclusively owned DB.
  await rm(root, { recursive: true, force: true });
}
