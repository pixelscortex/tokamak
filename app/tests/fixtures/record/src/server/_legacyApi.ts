import { createApi } from "@tokamak/sdk";
import type { api as generated } from "./_generated/api";
export const api = createApi<typeof generated>();
