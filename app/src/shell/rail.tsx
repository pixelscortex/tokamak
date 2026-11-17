import { For } from "solid-js";
import type { JSX } from "@solidjs/web";
import { TooltipTrigger } from "@ui-sdk/solid/tooltip";
import { Tooltip } from "@tokamak/ui";
import type { PluginView } from "../plugins/views";
import { useShell } from "./context";
import { TipText } from "./control";
import { SettingsMenu } from "./settings-menu";
import { hrefOf } from "./views";

/** Where plugins register: one quiet mark per view, settings at the foot. */
export function Rail(): JSX.Element {
  const shell = useShell();
  const views = () => {
    const connection = shell.session.connection();
    return connection.state === "connected" ? connection.plugins.views() : [];
  };
  return (
    <div class="flex w-12 shrink-0 flex-col items-center gap-1 pt-1 pb-3">
      <nav aria-label="Views" class="flex flex-col items-center gap-1">
        <For each={views()}>{(view) => <RailItem view={view} />}</For>
      </nav>
      <div class="flex-1" />
      <SettingsMenu side="right" />
    </div>
  );
}

function RailItem(props: { view: PluginView }): JSX.Element {
  const shell = useShell();
  const current = () => {
    const open = shell.navigation.current();
    return open?.plugin === props.view.plugin && open.id === props.view.id;
  };
  return (
    <Tooltip.Root>
      <TooltipTrigger
        data-current={current() || undefined}
        aria-current={current() ? "page" : undefined}
        aria-label={props.view.title}
        class="flex size-8 items-center justify-center rounded-sm text-label text-ink-3 transition duration-200 hover:bg-hover hover:text-ink data-current:bg-selected data-current:text-ink focus-ring"
        render={(trigger) => (
          <a
            {...trigger}
            href={hrefOf(props.view)}
            onClick={(event: MouseEvent) => {
              event.preventDefault();
              shell.navigation.openView(props.view);
            }}
          />
        )}
      >
        <span aria-hidden="true" class="flex size-4 items-center justify-center">
          {props.view.title.charAt(0).toUpperCase()}
        </span>
      </TooltipTrigger>
      <Tooltip.Content side="right">
        <TipText label={props.view.title} />
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
