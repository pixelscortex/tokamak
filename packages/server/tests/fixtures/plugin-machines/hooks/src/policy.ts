import { hook } from "@tokamak/sdk";
import { hookedAction, hookedPoint } from "plugin:machine-outsider/server";

export const action = hook(hookedAction, { before: (_ctx, args) => args });
export const point = hook(hookedPoint.points.gate, { before: (_ctx, value) => value + ":foreign" });
