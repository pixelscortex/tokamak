import type { Command } from "./command";
import build from "./commands/build";
import add from "./commands/add";
import remove from "./commands/remove";
import list from "./commands/list";
import open from "./commands/open";

export const commands: readonly Command[] = [build, add, remove, list, open];
