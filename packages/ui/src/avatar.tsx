/*
  <Avatar name="Kira Lee" />
  <Avatar name="Kira Lee" src={photo} size={16} />

  ui-sdk Avatar: a round image with the first initial as fallback, on the
  band tone. 24 by default, 16 in a row's trail.
  Slots: avatar, avatar-image, avatar-fallback.
*/
import { Avatar as UiAvatar, AvatarFallback, AvatarImage } from "@ui-sdk/solid/avatar";
import type { JSX } from "@solidjs/web";

export type AvatarProps = { name: string; src?: string; size?: 16 | 24; class?: string };

export function Avatar(props: AvatarProps): JSX.Element {
  return (
    <UiAvatar data-size={props.size ?? 24} class={props.class}>
      {props.src && <AvatarImage src={props.src} alt={props.name} />}
      <AvatarFallback role="img" aria-label={props.name}>
        {props.name.trim().charAt(0).toUpperCase()}
      </AvatarFallback>
    </UiAvatar>
  );
}
