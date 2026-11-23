import { workerDispatch, type WorkerMessage } from "./dispatch";
import { installConsole } from "./quickjs-console";
import { invocationProcesses } from "./program-scope";
import { quickJsPrograms, type NativeSpawn } from "./quickjs-process";
import { workerContracts } from "./contracts";
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

export async function initialize(
  send: (json: string) => void,
  nextOp: () => number,
  bundle: string,
  spawn: NativeSpawn,
): Promise<(frame: string) => void> {
  const emit = (message: object) => send(JSON.stringify(message));
  const logger = console;
  installConsole(logger, emit);

  const root = (await loadLocalModule(bundle)) as {
    functions: FunctionRegistry;
    contractProviders?: Record<string, Provider<"local">>;
  };
  const dispatch = workerDispatch(
    "local",
    root.functions,
    emit,
    nextOp,
    (signal, call) => invocationProcesses(signal, quickJsPrograms(spawn, call)),
    workerContracts(root, loadLocalModule),
    {
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
      errorMessage(error) {
        const message = error instanceof Error ? error.message : String(error);
        // QuickJS can reject with null if it cannot allocate its own InternalError.
        return error === null || message === "out of memory"
          ? "Plugin local function ran out of memory"
          : message;
      },
    },
  );
  return (frame) => dispatch(JSON.parse(frame) as WorkerMessage);
}
