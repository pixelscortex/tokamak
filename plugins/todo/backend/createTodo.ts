import type { Id } from "@tokamak/sdk";
import { assertReadable, MAX_TITLE_UNITS } from "./_limits";

type TodoWriter = {
  insert(table: "todos", value: { title: string; done: boolean }): Promise<Id<"todos">>;
  query(table: "todos"): { collect(): Promise<object[]> };
};

export async function createTodo(db: TodoWriter, title: string) {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("Enter a task title");
  if (trimmed.length > MAX_TITLE_UNITS) {
    throw new Error(`Task titles must be at most ${MAX_TITLE_UNITS} UTF-16 code units`);
  }
  const id = await db.insert("todos", { title: trimmed, done: false });
  // Throwing rolls back the insert when its committed list would be too large.
  assertReadable(await db.query("todos").collect());
  return id;
}
