import type { DatabaseWriter, Doc } from "@tokamak/sdk";
import type { Model } from "./_functions";
import { declinePendingTools, interruptTools } from "./parts";

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
      parts: interruptTools(
        status === "cancelled" && !run.model.startsWith("acp:")
          ? declinePendingTools(message.parts)
          : message.parts,
        error,
      ),
    });
}
