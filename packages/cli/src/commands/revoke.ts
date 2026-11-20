import { CommandError, type Command } from "../command";
import { serverRequest } from "../server";

export default {
  path: "revoke",
  summary: "Remove a member and disable their token.",
  args: { name: "id" },
  example: "tokamak revoke 00000000-0000-4000-8000-000000000000 --json",
  async run([id], { server }) {
    if (!id || id === "." || id === "..") throw new CommandError("Invalid member id", "tokamak members");
    const { body } = await serverRequest(
      `/members/${encodeURIComponent(id)}/revoke`,
      server,
      { method: "POST" },
      true,
    );
    const { revoked } = body as { revoked: string };
    return { data: { revoked }, text: `Revoked ${revoked}.` };
  },
} satisfies Command;
