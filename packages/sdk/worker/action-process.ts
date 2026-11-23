import { workerDispatch, type WorkerMessage } from "./dispatch";
import { installConsole } from "./quickjs-console";
import type { FunctionRegistry } from "../src/functions";

// Capture these before plugin module initialization can modify the realm.
const { stringify, parse } = JSON;
const { setPrototypeOf } = Object;
const string = String;
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
      observeInvocation: true,
      abort(controller) {
        try {
          controller.abort();
        } catch {
          // A throwing abort listener cannot leave operations active.
        }
      },
      errorMessage(error) {
        if (error instanceof Error) return error.message;
        try {
          return `Server action threw ${string(error)}`;
        } catch {
          return "Server action threw [unprintable value]";
        }
      },
      errorStack(error) {
        return error instanceof Error ? error.stack?.slice(0, 32768) : undefined;
      },
    },
  );
  return (frame: string) => dispatch(parse(frame) as WorkerMessage);
}
