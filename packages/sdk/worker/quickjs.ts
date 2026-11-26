import { workerDispatch, type WorkerMessage } from "./dispatch";
import { dispatchChannels, type PeerMessage } from "./dispatch-channels";
import { installConsole } from "./quickjs-console";
import { invocationProcesses } from "./program-scope";
import { quickJsPrograms, type NativeSpawn } from "./quickjs-process";
import { dataContracts, workerContracts } from "./contracts";
import type { HookRegistry } from "../src/hooks";
import type { FunctionRegistry } from "../src/functions";
import type { Provider } from "../src/internal/contracts";

async function loadLocalModule(path: string) {
  try {
    return await import(path);
  } catch (error) {
    if (
      error instanceof SyntaxError &&
      error.message === "Could not find export 'win32' in module 'node:path'"
    ) {
      throw new SyntaxError("node:path on the plugin host has no win32", { cause: error });
    }
    throw error;
  }
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // QuickJS can reject with null if it cannot allocate its own InternalError.
  return error === null || message === "out of memory" ? "Plugin action ran out of memory" : message;
}

export async function initialize(
  trySend: (json: string) => boolean,
  sendWaiting: (json: string) => Promise<void>,
  nextOp: () => number,
  bundle: string,
  spawn: NativeSpawn,
): Promise<(frame: string) => void> {
  const { stringify, parse } = JSON;
  const { setPrototypeOf } = Object;
  const serialize = (message: object) => stringify(setPrototypeOf(message, null));
  const emit = (message: object) => {
    if (!trySend(serialize(message))) throw new Error("Plugin process output queue exceeds 4 MiB limit");
  };
  const emitWaiting = (message: object) => {
    const json = serialize(message);
    // Preserve immediate operation delivery unless the writer is actually full.
    if (!trySend(json)) return sendWaiting(json);
  };
  const logger = console;
  installConsole(logger, emit);
  const channels = dispatchChannels(emitWaiting, nextOp, errorMessage);

  const root = (await loadLocalModule(bundle)) as {
    functions: FunctionRegistry;
    hooks?: HookRegistry;
    contractProviders?: Record<string, Provider<"caller">>;
  };
  const dispatch = workerDispatch("runner", root.functions, emit, nextOp, {
    hooks: root.hooks,
    createPrograms: (signal, call) => invocationProcesses(signal, quickJsPrograms(spawn, call)),
    contracts: workerContracts(),
    contract: dataContracts(root),
    attachChannel: channels.attach,
    sendWaiting: emitWaiting,
    abort(controller) {
      try {
        controller.abort();
      } catch (error) {
        // LLRT can propagate a listener exception out of abort().
        try {
          logger.error(error);
        } catch {
          // Logging must not prevent the dispatcher from rejecting pending operations.
        }
      }
    },
    errorMessage,
  });
  return (frame) => {
    const message = parse(frame) as WorkerMessage | PeerMessage;
    if (message.type === "peer") void channels.receive(message).catch(() => {});
    else dispatch(message);
  };
}
