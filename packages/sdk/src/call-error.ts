import type { CallErrorDetails } from "./protocol";

export type CallError = string | ({ message: string } & CallErrorDetails);
import type { JsonValue } from "./values";

const remoteFunctionError = Symbol.for("tokamak.remoteFunctionError");

export function isRemoteFunctionError(value: unknown): value is RemoteFunctionError {
  return value instanceof Error && remoteFunctionError in value;
}

export class RemoteFunctionError extends Error {
  readonly [remoteFunctionError] = true;
  declare readonly plugin?: string;
  declare readonly hook?: string;
  declare readonly stage?: string;
  declare readonly table?: string;
  declare readonly kind?: string;
  declare readonly data?: JsonValue;

  constructor(error: CallError) {
    super(typeof error === "string" ? error : error.message);
    if (typeof error !== "string") Object.assign(this, error);
  }
}

export function isStructuredCallError(value: unknown): value is CallErrorDetails {
  return (
    value !== null &&
    typeof value === "object" &&
    ["plugin", "hook", "stage", "kind"].every(
      (key) => typeof (value as Record<string, unknown>)[key] === "string",
    ) &&
    Object.hasOwn(value, "data")
  );
}
