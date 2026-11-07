/** Runtime elements must never accidentally acquire DOM/Node ambient globals. */
// @ts-expect-error QuickJS has no browser document.
void document;
// @ts-expect-error QuickJS has no browser window.
void window;
// @ts-expect-error Node types belong only to build tooling.
void process;
// @ts-expect-error Node module loading is not available in native components.
void require;
export {};
