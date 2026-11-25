import { symlinkSync } from "node:fs";

for (const id of ["team", "moderation", "z-extra"]) {
  try {
    symlinkSync(
      new URL("../../../../../app/node_modules", import.meta.url),
      new URL(`./${id}/node_modules`, import.meta.url),
      "dir",
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
