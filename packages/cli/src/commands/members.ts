import type { Command } from "../command";
import { memberRequest } from "../server";

type Member = { id: string; name: string; role: string; revoked_at: number | null };

export default {
  usesServer: true,
  path: "members",
  summary: "List the server's members.",
  example: "tokamak members --json",
  async run(_, { server }) {
    const { body } = await memberRequest("members", "/members", server);
    const members = (body as Member[])
      .filter(({ revoked_at }) => revoked_at === null)
      .map(({ id, name, role }) => ({ id, name, role }));
    return {
      data: { members },
      text: members.map(({ id, name, role }) => `${id}\t${name}\t${role}`).join("\n"),
    };
  },
} satisfies Command;
