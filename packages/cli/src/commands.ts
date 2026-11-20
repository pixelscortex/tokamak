import type { Command } from "./command";
import build from "./commands/build";
import add from "./commands/add";
import remove from "./commands/remove";
import list from "./commands/list";
import logs from "./commands/logs";
import reload from "./commands/reload";
import members from "./commands/members";
import invite from "./commands/invite";
import revoke from "./commands/revoke";
import { serverStart, serverStop, serverStatus } from "./commands/server";

import doctor from "./commands/doctor";
import report from "./commands/report";

const peopleAndServer = [members, invite, revoke, serverStart, serverStop, serverStatus];

export const commands: readonly Command[] = [
  build,
  add,
  remove,
  list,
  reload,
  logs,
  ...peopleAndServer,
  doctor,
  report,
];
