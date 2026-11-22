/*
  <Avatar name="Sam Lee" />
  <Avatar name="Sam Lee" src={photo} size={16} />

  A round image with the first initial as fallback. 24 by default, 16 in a
  row's trail, 18 before a message's author.
*/
import { Avatar as Base, AvatarFallback, AvatarImage } from "@ui-sdk/solid/avatar";
import type { JSX } from "@solidjs/web";
import { cn } from "./cn.ts";

export type AvatarProps = { name: string; src?: string; size?: 16 | 18 | 24; class?: string };

export function Avatar(props: AvatarProps): JSX.Element {
  return (
    <Base
      data-slot="avatar"
      class={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-lifted text-ink-2",
        props.size === 16
          ? "size-4 text-label"
          : props.size === 18
            ? "size-avatar text-initial"
            : "size-6 text-label",
        props.class,
      )}
    >
      {props.src && <AvatarImage src={props.src} alt={props.name} class="size-full object-cover" />}
      <AvatarFallback role="img" aria-label={props.name}>
        {props.name.trim().charAt(0).toUpperCase()}
      </AvatarFallback>
    </Base>
  );
}
