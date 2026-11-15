export function ComposerStrip(props: { title: string; model: string; turns: number; onModel: () => void }) {
  return <div class="flex min-w-0 items-center justify-between gap-4 border-t border-hairline pt-3 font-label text-[9px] leading-4 uppercase tracking-[0.08em] text-text-3">
    <span class="min-w-0 flex-1 truncate">{props.title}</span>
    <span class="flex shrink-0 items-center gap-2">
      <button aria-label="Change model (⌘M)" onClick={() => props.onModel()} class="m-0 cursor-pointer border-0 bg-transparent p-0 font-label text-[9px] uppercase text-text-3">{props.model}</button>
      <span>· {props.turns} {props.turns === 1 ? "turn" : "turns"}</span>
    </span>
  </div>;
}
