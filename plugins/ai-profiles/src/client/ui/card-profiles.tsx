import { For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon, Menu, icons } from "@tokamak/ui";
import type { Subscription } from "../lib/api";
import type { Builder } from "../lib/builder";
import { profileGlyph } from "../lib/profile-icons";

/**
 * The end of a subscription card's model line (Paper "1 · Profiles · screen"):
 * the codes of the profiles that use it, then "Add to profile", the keyboard's
 * way to do what dragging the card does. The menu lists every profile; one
 * that already holds the card is marked "added" and cannot be picked, and
 * while the menu is open those profiles fade below, as they do during a drag.
 * The button shows when the card is pointed at or focused.
 */
export function CardProfiles(props: { subscription: Subscription; builder: Builder }): JSX.Element {
  const id = () => props.subscription.id;
  const codes = () => props.builder.codesOf(id());
  return (
    <span class="flex shrink-0 items-center gap-2">
      <For each={codes()}>
        {(code) => (
          <span class="flex items-center gap-1 text-data text-ink-3">
            <Icon path={profileGlyph} size={12} />
            {code}
          </span>
        )}
      </For>
      {/* Hidden during a drag: the carried card holds the pointer, so it counts as pointed at. */}
      <span
        data-dragging={props.builder.drag.carry() ? "" : undefined}
        class="opacity-0 transition group-hover/card:opacity-100 group-focus-within/card:opacity-100 has-data-open:opacity-100 data-dragging:invisible"
      >
        <Menu.Root
          // The menu calls these from its own effects: read the id without tracking it.
          onOpenChange={(open: boolean) => props.builder.setOffered(open ? untrack(id) : undefined)}
          onAction={(profile: string) => void props.builder.add(profile, untrack(id))}
        >
          <Menu.Trigger
            variant="ghost"
            size="sm"
            icon={icons.add}
            label={`Add ${props.builder.nameOf(id())} to a profile`}
          />
          <Menu.Content>
            <Menu.Group>
              <Menu.GroupLabel>Add to profile</Menu.GroupLabel>
              <For each={props.builder.profiles()}>
                {(profile) => {
                  const holds = () => profile.subscriptions.includes(id());
                  return (
                    <Menu.Item value={profile.id} disabled={holds()}>
                      <span class="text-code">{profile.code}</span>
                      <span class="min-w-0 flex-1 truncate">{profile.name}</span>
                      <Show when={holds()}>
                        <span class="text-label text-ink-3">added</span>
                      </Show>
                    </Menu.Item>
                  );
                }}
              </For>
              <Show when={!props.builder.profiles().length}>
                <Menu.Item value="" disabled>
                  No profiles yet
                </Menu.Item>
              </Show>
            </Menu.Group>
          </Menu.Content>
        </Menu.Root>
      </span>
    </span>
  );
}
