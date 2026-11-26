import { contract, type AuthContext } from "@tokamak/sdk";

export const identity = contract<{ current(): Promise<AuthContext> }>("identity", { on: "caller" });
