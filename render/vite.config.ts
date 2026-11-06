/** Native library-mode build: no HTML entry, dev server, DOM, or HMR. */
import { fileURLToPath } from "node:url";
import { nativeConfig } from "./tools/native-build";

export default nativeConfig(fileURLToPath(new URL(".", import.meta.url)));
