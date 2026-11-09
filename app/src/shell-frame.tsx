/** Presentation only. Replace this markup/styles for the Paper pass while
 * preserving the named slots; navigation and plugin lifetime live in shell.tsx. */
import type { JSX } from "@tokamak/render";
export interface ShellFrameProps {
  rail: JSX.Element;
  navigation: JSX.Element;
  sidebar?: JSX.Element;
  stage: JSX.Element;
  thread?: JSX.Element;
}
export function ShellFrame(props: ShellFrameProps) {
  return <div class="shell-frame">
    <nav class="shell-rail" aria-label="Workspace">{props.rail}</nav>
    <div class="shell-workspace">
      <header class="shell-navigation">{props.navigation}</header>
      <div class="shell-content">
        <aside class="shell-sidebar" aria-label="Sidebar">{props.sidebar}</aside>
        <main class="shell-stage">{props.stage}</main>
        <aside class="shell-thread" aria-label="Thread panel">{props.thread}</aside>
      </div>
    </div>
  </div>;
}
