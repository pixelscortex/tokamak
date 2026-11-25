import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function readProjectFile(file: string) {
  return readFile(join(dirname(file), "input"), "utf8");
}
