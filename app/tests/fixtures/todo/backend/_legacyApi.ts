import { createApi } from "@tokamak/sdk";
import type { api as generated } from "./_generated/api";

// These retired fixtures exercise the raw-bundle loader, whose function names
// are unqualified. Keep generated types while opting into that legacy routing.
export const api = createApi<typeof generated>();
