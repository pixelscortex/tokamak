import type { DatabaseWriter, ModelFromSchema } from "@tokamak/sdk";
import schema from "./schema";
export function createRecord(db: DatabaseWriter<ModelFromSchema<typeof schema>>, title: string) {
  title = title.trim();
  if (!title) throw new Error("Enter a task title");
  return db.insert("records", { title, done: false });
}
