import { contract } from "@tokamak/sdk";

export const probe = contract<{ read(input: {}): Promise<string> }>("probe", { on: "caller" });
