/** The chat plugin's public, moddable client surface. */
export { Composer } from "./ui/composer/chat-composer";
export { ComposerInput } from "./ui/composer/composer-input";
export { ComposerStrip } from "./ui/composer/composer-strip";
export { SendButton } from "./ui/composer/send-button";
export {
  composerBefore,
  composerActions,
  composerStripLeft,
  composerStripRight,
  composerAfter,
  useComposer,
} from "./lib/composer";
export type { ComposerAPI, ComposerSlotProps } from "./lib/composer";

export { Chat } from "./pages/screen";
export { api } from "./lib/api";
