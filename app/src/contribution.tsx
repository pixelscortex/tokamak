/** Every slot owns an error boundary and reactive generation. Keying the owner
 * retires effects/resources before mounting an updated plugin contribution. */
import { ErrorBoundary, Show, createSignal, onCleanup, type Accessor, type Component } from "solid-js";
import { createComponent } from "@tokamak/render";
import type { ModuleExports } from "@tokamak/runtime/modules";
import type { PluginLoader, SlotContribution } from "@tokamak/runtime/plugins";

export function Contribution(props: {
  loader: PluginLoader;
  contribution: SlotContribution;
  componentProps?: Record<string, unknown>;
}) {
  return <Show keyed when={`${props.contribution.plugin}:${props.contribution.id}:${props.loader.version(props.contribution.plugin)}`}>
    {(_generation: string) => <ErrorBoundary fallback={(_cause: unknown) => <div class="plugin-error" role="alert" style="display:flex;align-items:center">
      {/* Blitz can hit the anonymous inline formatting box instead of an inline
          button. Flex gives Reload its own hit-test box without changing CSS. */}
      <span>{props.contribution.plugin} failed · </span>
      <button onClick={() => props.loader.reload(props.contribution.plugin)}>Reload</button>
    </div>}>
      <LoadedContribution {...props} />
    </ErrorBoundary>}
  </Show>;
}
function LoadedContribution(props: Parameters<typeof Contribution>[0]) {
  const [module, setModule] = createSignal<ModuleExports>();
  const [failure, setFailure] = createSignal<{ cause: unknown }>();
  // Factory roots are deliberately separate from view roots. Their errors are
  // attributed by module id, then bridged into each consuming boundary.
  onCleanup(props.loader.onError(props.contribution.plugin, cause => setFailure({ cause })));
  let alive = true;
  onCleanup(() => { alive = false; });
  // Solid's resource scheduler requires queueMicrotask, absent in QuickJS.
  // Native already settles promise jobs before painting; an owned signal is
  // sufficient and ignores completions after this contribution is retired.
  void props.loader.load(props.contribution.plugin).then(exports => {
    if (alive) setModule(() => exports);
  }, cause => { if (alive) setFailure({ cause }); });
  const loaded = () => {
    const failed = failure();
    if (failed) throw failed.cause;
    return module();
  };
  return <Show when={loaded()} fallback={<p role="status">Loading {props.contribution.plugin}…</p>}>
    {(exports: Accessor<ModuleExports>) => {
      const component = exports()[props.contribution.id];
      if (typeof component !== "function") throw new Error(`Missing contribution export ${props.contribution.id}`);
      if (props.contribution.kind === "command") return <CommandContribution
        handler={component as (args: Record<string, unknown>) => unknown}
        args={props.componentProps ?? {}} title={props.contribution.options.title!} />;
      return createComponent(component as Component<Record<string, unknown>>, props.componentProps ?? {});
    }}
  </Show>;
}


function CommandContribution(props: {
  handler: (args: Record<string, unknown>) => unknown;
  args: Record<string, unknown>;
  title: string;
}) {
  const [failure, setFailure] = createSignal<{ cause: unknown }>();
  const [pending, setPending] = createSignal(false);
  const label = () => {
    const failed = failure();
    if (failed) throw failed.cause;
    return props.title;
  };
  return <button disabled={pending()} onClick={() => {
    setPending(true);
    // Event and async failures must re-enter a reactive computation owned by
    // this contribution's boundary; they cannot escape the native dispatch.
    void Promise.resolve().then(() => props.handler(props.args)).catch(cause => {
      setFailure({ cause });
    }).finally(() => setPending(false));
  }}>{label()}</button>;
}
