import { CommandError, type Command } from "../command";
import { memberRequest } from "../server";

export default {
  usesServer: true,
  path: "revoke",
  summary: "Remove a member and disable their token.",
  args: { name: "id" },
  example: "tokamak revoke 00000000-0000-4000-8000-000000000000 --json",
  async run([id], { server }) {
    if (!id || !/^(?:owner|local|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(id))
      throw new CommandError("Invalid member id", "tokamak members");
    const { body } = await memberRequest("revoke", `/members/${id}/revoke`, server, { method: "POST" });
    const { revoked } = body as { revoked: string };
    return { data: { revoked }, text: `Revoked ${revoked}.` };
  },
} satisfies Command;
