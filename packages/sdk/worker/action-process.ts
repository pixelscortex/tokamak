import { workerDispatch, type WorkerMessage } from "./dispatch";
import { installConsole } from "./quickjs-console";
import type { FunctionRegistry } from "../src/functions";

// Capture these before plugin module initialization can modify the realm.
const { stringify, parse } = JSON;
const { setPrototypeOf } = Object;
function emit(send: (json: string) => void, message: object) {
  send(stringify(setPrototypeOf(message, null)));
}

export function logging(send: (json: string) => void) {
  installConsole(console, (message) => emit(send, message));
}

export function initialize(send: (json: string) => void, nextOp: () => number, functions: FunctionRegistry) {
  const dispatch = workerDispatch(
    "action",
    functions,
    (message) => emit(send, message),
    nextOp,
    undefined,
    undefined,
    {
      abort(controller) {
        try {
          controller.abort();
        } catch {
          // A throwing abort listener cannot leave operations active.
        }
      },
      errorMessage(error) {
        const message = error instanceof Error ? error.message : String(error);
        return error === null || message === "out of memory" ? "Plugin action ran out of memory" : message;
      },
      errorStack(error) {
        return error instanceof Error ? error.stack?.slice(0, 32768) : undefined;
      },
    },
  );
  return (frame: string) => dispatch(parse(frame) as WorkerMessage);
}
