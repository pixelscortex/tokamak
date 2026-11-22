/** States in which a turn holds its thread (one writer); a second turn cannot begin. */
export const ACTIVE = ["running", "waiting"] as const;
/** States of a turn that ran and has ended. */
export const ENDED = ["done", "failed", "stopped", "interrupted"] as const;

import type { AuthContext } from "@tokamak/sdk";

export function isSendersDevice(
  turn: { sender: { id: string; device: string } },
  auth: Pick<AuthContext, "user" | "device">,
) {
  return turn.sender.id === auth.user.id && turn.sender.device === auth.device.id;
}

/** Whether two turns were sent by the same person from the same device. */
export function sameSender(
  a: { sender: { id: string; device: string } },
  b: { sender: { id: string; device: string } },
) {
  return a.sender.id === b.sender.id && a.sender.device === b.sender.device;
}

export function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
