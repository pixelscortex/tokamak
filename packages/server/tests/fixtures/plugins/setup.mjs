// These source fixtures are outside the workspace package list. Give both
// peers installed dependencies before either public API is inspected.
import { symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
for (const id of ["a", "b"]) {
  try {
    symlinkSync(
      fileURLToPath(new URL("../../../../../app/node_modules", import.meta.url)),
      fileURLToPath(new URL(`./${id}/node_modules`, import.meta.url)),
      "dir",
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
