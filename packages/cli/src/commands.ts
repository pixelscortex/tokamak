import type { Command } from "./command";
import build from "./commands/build";
import add from "./commands/add";
import remove from "./commands/remove";
import list from "./commands/list";

import doctor from "./commands/doctor";
import report from "./commands/report";

export const commands: readonly Command[] = [build, add, remove, list, doctor, report];
