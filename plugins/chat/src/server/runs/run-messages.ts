import type { DatabaseWriter, Doc } from "@tokamak/sdk";
import type { Model } from "../_functions";
import { interruptTools } from "../messages/parts";

export async function interruptResponse(
  db: DatabaseWriter<Model>,
  run: Doc<Model, "runs">,
  status: "error" | "cancelled",
  error: string,
) {
  const message = await db.get(run.messageId);
  if (message)
    await db.patch(run.messageId, {
      status,
      ...(status === "error" ? { error } : {}),
      parts: interruptTools(message.parts, error),
    });
}
