import { action } from "./_functions";

export const list = action({ handler: ({ acp }) => acp.agents() });
