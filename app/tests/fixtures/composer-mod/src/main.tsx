import { fill, wrap, replace } from "@tokamak/sdk/client";
import {
  ComposerInput,
  SendButton,
  composerActions,
  composerStripRight,
  composerBefore,
} from "@plugins/chat/ui";
export const Insert = fill(composerActions, { order: 10, id: "insert" }, (props) => (
  <button id="mod-insert" onClick={() => props.composer.insertText("mod text")}>
    Insert text
  </button>
));
export const Label = fill(composerStripRight, {}, () => <span id="mod-label">MOD ACTIVE</span>);
export const Frame = wrap(ComposerInput, (Original) => (props) => (
  <div id="mod-frame" class="min-w-0 flex-1 border border-edge">
    <Original {...props} />
  </div>
));
export const Broken = fill(composerBefore, {}, () => {
  throw new Error("intentional fill failure");
});
// A bad outer wrapper falls back to Frame, which in turn renders the editor.
export const ZBrokenFrame = wrap(ComposerInput, (_Original) => (_props) => {
  throw new Error("intentional wrapper failure");
});

export const Send = fill(composerActions, { order: 20 }, () => <SendButton />);
export const ReplaceA = replace(SendButton, () => <span id="mod-replacement">First replacement</span>);
export const ReplaceB = replace(SendButton, () => <span id="mod-ignored">Ignored replacement</span>);
