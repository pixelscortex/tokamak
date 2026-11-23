import { workerDispatch, type WorkerMessage } from "./dispatch";
import { installConsole } from "./quickjs-console";
import { workerContracts } from "./contracts";
import type { FunctionRegistry } from "../src/functions";
import type { Provider } from "../src/internal/contracts";

export async function initialize(
  send: (json: string) => void,
  nextOp: () => number,
  bundle: string,
): Promise<(frame: string) => void> {
  const emit = (message: object) => send(JSON.stringify(message));
  const logger = console;
  installConsole(logger, emit);

  const root = (await import(bundle)) as {
    functions: FunctionRegistry;
    contractProviders?: Record<string, Provider<"local">>;
  };
  const unavailable = (): never => {
    throw new Error("Programs are not available on the QuickJS host yet");
  };
  const dispatch = workerDispatch(
    "local",
    root.functions,
    emit,
    nextOp,
    () => ({ start: unavailable, scope: unavailable, close: async () => {} }),
    workerContracts(root, (path) => import(path)),
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
