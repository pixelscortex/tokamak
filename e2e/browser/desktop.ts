import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserContext } from "@playwright/test";
import { installFakeAgent, localLauncher } from "../fake-agent/local.mjs";

type Launched = Awaited<ReturnType<ReturnType<typeof localLauncher>>>;
/** The arguments of the window's Tauri commands, as the app sends them (app/src/host). */
interface Call {
  readonly id: string;
  readonly plugin: string;
  readonly entryHash: string;
  readonly codeHash: string;
  readonly events: number;
  readonly message: unknown;
}
/** What the test desktop adds to the page. */
interface DesktopWindow {
  isTauri: boolean;
  __TAURI_INTERNALS__: unknown;
  __tokamakDesktop(command: string, args: Record<string, unknown>): Promise<unknown>;
  __tokamakDesktopEvent(channel: number, payload: unknown): void;
}

/**
 * Makes the app in `context` run as the desktop app does: the window's Tauri
 * calls are answered by this test process, which starts each plugin's real
 * local part (Bun, the installed build) with the desktop's short environment
 * and every fake agent's command on its PATH. Returns the person's home folder
 * and the PATH folder holding those commands (unlink one to "uninstall" it).
 */
export async function asDesktop(context: BrowserContext): Promise<{
  home: string;
  bin: string;
  closeWorkers(): Promise<void>;
  /** Quits the app as the menu or Cmd+Q would (app/src-tauri/src/quit.rs). */
  requestQuit(): Promise<void>;
  /** The window's answers so far: "hold", "cancel", "confirm". */
  readonly quitAnswers: readonly string[];
}> {
  // Inside the run's folder, which the runner removes at the end.
  const plugins = process.env.TOKAMAK_PLUGIN_DIR!;
  const scratch = await mkdtemp(join(dirname(plugins), "desktop-"));
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  await mkdir(home);
  await installFakeAgent(bin);
  const launch = localLauncher((id: string) => join(plugins, id, "dist"), {
    HOME: home,
    TOKAMAK_APP_DATA_DIR: join(scratch, "app-data"),
    PATH: `${bin}:/usr/bin:/bin`,
  });
  const workers = new Map<string, Launched>();
  let next = 0;
  /** The window's quit channel and a way to send on it, once it listens. */
  let quitChannel: ((message: unknown) => Promise<void>) | undefined;
  const quitAnswers: string[] = [];
  const closeWorker = async (id: string) => {
    const worker = workers.get(id);
    workers.delete(id);
    await worker?.close();
  };
  const closeWorkers = async () => {
    // As in the native host, stop accepting writes before closing the workers.
    const closing = [...workers.values()];
    workers.clear();
    await Promise.all(closing.map((worker) => worker.close()));
  };

  await context.exposeBinding("__tokamakDesktop", async ({ page }, command: string, args: Call) => {
    switch (command) {
      case "tokamak_endpoint":
        return {
          http: "http://127.0.0.1:43123",
          ws: "ws://127.0.0.1:43123/ws",
          token: process.env.VITE_TOKAMAK_TOKEN,
        };
      case "local_worker_start": {
        let index = 0;
        // Tauri channels deliver `{ index, message }` to the callback the window registered.
        const deliver = (message: unknown) =>
          page
            .evaluate(
              ([id, payload]) => (window as unknown as DesktopWindow).__tokamakDesktopEvent(id, payload),
              [args.events, { index: index++, message }] as const,
            )
            .catch(() => {});
        const id = `worker-${++next}`;
        const worker = await launch(
          { id: args.plugin, entryHash: args.entryHash, codeHash: args.codeHash },
          (message: unknown) => void deliver({ type: "message", message }),
          (reason: string) => {
            workers.delete(id);
            void deliver({ type: "closed", reason });
          },
        );
        workers.set(id, worker);
        page.once("close", () => void closeWorker(id));
        if (page.isClosed()) await closeWorker(id);
        return id;
      }
      case "local_worker_write":
        return workers.get(args.id)?.send(args.message);
      case "local_worker_load":
        return workers
          .get(args.id)
          ?.load({ id: args.plugin, entryHash: args.entryHash, codeHash: args.codeHash });
      case "quit_listen": {
        let index = 0;
        quitChannel = (message) =>
          page.evaluate(
            ([id, payload]) => (window as unknown as DesktopWindow).__tokamakDesktopEvent(id, payload),
            [args.events, { index: index++, message }] as const,
          );
        return null;
      }
      case "quit_hold":
      case "quit_cancel":
        quitAnswers.push(command.slice("quit_".length));
        return null;
      case "quit_confirm":
        // As the desktop does: close every local worker, which ends each agent program with it.
        quitAnswers.push("confirm");
        await closeWorkers();
        return null;
      case "local_worker_close":
        await closeWorker(args.id);
        return null;
      default:
        throw new Error(`The test desktop has no ${command}`);
    }
  });

  await context.addInitScript(() => {
    const callbacks = new Map<number, (payload: unknown) => void>();
    let id = 0;
    const scope = window as unknown as DesktopWindow;
    scope.isTauri = true;
    // The desktop opens a welcome page on its first start with the local server; these tests start on chat.
    localStorage.setItem("tokamak.welcomed", "1");
    scope.__tokamakDesktopEvent = (channel: number, payload: unknown) => callbacks.get(channel)?.(payload);
    scope.__TAURI_INTERNALS__ = {
      transformCallback(callback: (payload: unknown) => void) {
        callbacks.set(++id, callback);
        return id;
      },
      unregisterCallback(channel: number) {
        callbacks.delete(channel);
      },
      invoke(command: string, args: Record<string, unknown> = {}) {
        // A Channel travels as its callback id, as Tauri serialises it.
        const plain = Object.fromEntries(
          Object.entries(args).map(([key, value]) => [
            key,
            value && typeof value === "object" && "toJSON" in value
              ? (value as unknown as { id: number }).id
              : value,
          ]),
        );
        return scope.__tokamakDesktop(command, plain);
      },
    };
  });
  return {
    home,
    bin,
    // Simulate the native host shutting down its workers when the window reloads.
    closeWorkers,
    async requestQuit() {
      if (!quitChannel) throw new Error("The window is not listening for quit");
      await quitChannel({ type: "quit" });
    },
    quitAnswers,
  };
}
