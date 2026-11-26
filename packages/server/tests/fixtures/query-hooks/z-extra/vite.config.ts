import "../setup.mjs";

import { tokamak } from "../../../../../build/src/vite.ts";
export default { plugins: [tokamak({ ui: false })] };
