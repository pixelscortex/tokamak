import { tokamak } from "@tokamak/build/vite";
export default { plugins: [tokamak({ backend: false, plugin: { id: "composer-mod", version: "0.1.0" } })] };
