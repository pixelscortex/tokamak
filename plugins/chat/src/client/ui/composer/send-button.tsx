import { useComposer } from "../../lib/composer";
/** The current keyboard-first layout has no visible send affordance. Mods can
 * place this public control in the actions slot without replacing the composer. */
export function SendButton() {
  const composer = useComposer();
  return (
    <button
      aria-label="Send"
      disabled={composer.busy() || !composer.draft().trim()}
      onClick={() => void composer.submit()}
    >
      Send
    </button>
  );
}
