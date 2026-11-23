import { workerDispatch, type WorkerMessage } from "./dispatch";
import { workerContracts } from "./contracts";
import type { FunctionRegistry } from "../src/functions";
import type { Provider } from "../src/internal/contracts";

export async function initialize(
  send: (json: string) => void,
  nextOp: () => number,
  bundle: string,
): Promise<(frame: string) => void> {
  const emit = (message: object) => send(JSON.stringify(message));
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) =>
      emit({
        type: "log",
        level,
        text: args
          .map((arg) => String(arg))
          .join(" ")
          .slice(0, 8192),
      });
  }

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
    workerContracts(root, async () => {
      throw new Error("Loading another plugin's local contracts is not available on the QuickJS host yet");
    }),
  );
  return (frame) => dispatch(JSON.parse(frame) as WorkerMessage);
}
