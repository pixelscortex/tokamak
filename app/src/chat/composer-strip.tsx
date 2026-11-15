export function ComposerStrip(props: { title: string; model: string; turns: number }) {
  return <div class="flex min-w-0 items-center justify-between gap-4 border-t border-hairline pt-3 font-label text-[9px] leading-4 uppercase tracking-[0.08em] text-text-3">
    <span class="min-w-0 flex-1 truncate">{props.title}</span>
    <span class="shrink-0">{props.model} · {props.turns} {props.turns === 1 ? "turn" : "turns"}</span>
  </div>;
}
