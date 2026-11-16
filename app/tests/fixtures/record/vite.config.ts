import { tokamak } from "@tokamak/build/vite";
export default {
  plugins: [tokamak({ plugin: { id: "record", version: "1.0.0", exports: "./api.ts" } })],
};
