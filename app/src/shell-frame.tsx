/** Presentation only: a bare window with one quiet stage.
 * Navigation and plugin lifetime stay in shell.tsx, behind named slots.
 *
 * The strip is the window's drag area and sits under the native window
 * buttons. Its switcher and history are not part of the product's face yet:
 * styles.css lays them out only when the page root carries `data-dev-nav`,
 * which the plugin tests set to reach plugin views and route history. */
import type { JSX, NativeEvent } from "@tokamak/render";
export interface ShellFrameProps {
  switcher: JSX.Element;
  navigation: JSX.Element;
  stage: JSX.Element;
  onKeyDown?: (event: NativeEvent) => void;
}
export function ShellFrame(props: ShellFrameProps) {
  return <div class="shell-frame" onKeyDown={props.onKeyDown}>
    <header class="shell-strip" window-drag>
      <nav class="shell-switcher" aria-label="Workspace">{props.switcher}</nav>
      <nav class="shell-navigation" aria-label="History">{props.navigation}</nav>
    </header>
    <main class="shell-stage">{props.stage}</main>
  </div>;
}
