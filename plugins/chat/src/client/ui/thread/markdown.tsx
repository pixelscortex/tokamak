import { Errored, For, Show, createMemo } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Lexer, type Token, type Tokens } from "marked";
import { CodeBlock } from "@tokamak/ui";

/** Lexes once per change and keeps unchanged blocks' identity, so streaming only re-renders the tail. */
export function lex(text: string, previous?: Token[]): Token[] | undefined {
  try {
    return Lexer.lex(text, { gfm: true }).map((token, index) => {
      const before = previous?.[index];
      return before?.type === token.type && before.raw === token.raw ? before : token;
    });
  } catch {
    return undefined;
  }
}

export function Markdown(props: { text: string }): JSX.Element {
  const tokens = createMemo<Token[] | undefined>((previous) => lex(props.text, previous));
  return (
    <div class="flex min-w-0 max-w-read flex-col gap-3 text-read break-words text-ink">
      <Errored fallback={() => <p class="whitespace-pre-wrap">{props.text}</p>}>
        <Show when={tokens()} fallback={<p class="whitespace-pre-wrap">{props.text}</p>}>
          {(list) => <Blocks tokens={list()} depth={0} />}
        </Show>
      </Errored>
    </div>
  );
}

function Blocks(props: { tokens: Token[]; depth: number }): JSX.Element {
  return (
    <For each={props.tokens}>{(token) => (props.depth > 8 ? token.raw : block(token, props.depth))}</For>
  );
}

function Inline(props: { tokens: Token[] | undefined; depth: number }): JSX.Element {
  return (
    <For each={props.tokens ?? []}>
      {(token) => (props.depth > 8 ? token.raw : inline(token, props.depth))}
    </For>
  );
}

const align = { left: "text-start", center: "text-center", right: "text-end" } as const;

function block(token: Token, depth: number): JSX.Element {
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
      return (
        <p>
          <Inline tokens={token.tokens} depth={depth + 1} />
        </p>
      );
    case "heading":
      return (
        <p role="heading" aria-level={Math.min(6, token.depth + 2)} class="font-semibold">
          <Inline tokens={token.tokens} depth={depth + 1} />
        </p>
      );
    case "code":
      return <CodeBlock code={token.text} language={token.lang?.split(/\s/)[0] || undefined} />;
    case "blockquote":
      return (
        <blockquote class="flex flex-col gap-3 border-s-2 border-edge-strong ps-4 text-ink-2">
          <Blocks tokens={token.tokens ?? []} depth={depth + 1} />
        </blockquote>
      );
    case "list":
      return <List token={token as Tokens.List} depth={depth} />;
    case "table":
      return <Table token={token as Tokens.Table} depth={depth} />;
    case "hr":
      return <hr class="border-edge" />;
    case "text":
      return token.tokens ? <Inline tokens={token.tokens} depth={depth + 1} /> : token.text;
    default:
      return <p class="whitespace-pre-wrap">{token.raw}</p>;
  }
}

function List(props: { token: Tokens.List; depth: number }): JSX.Element {
  const items = () => (
    <For each={props.token.items}>
      {(item) => (
        <li class="ps-1">
          <span class="flex flex-col gap-1">
            <Blocks tokens={item.tokens} depth={props.depth + 1} />
          </span>
        </li>
      )}
    </For>
  );
  return props.token.ordered ? (
    <ol start={Number(props.token.start) || 1} class="flex list-decimal flex-col gap-1 ps-6">
      {items()}
    </ol>
  ) : (
    <ul class="flex list-disc flex-col gap-1 ps-6">{items()}</ul>
  );
}

function Table(props: { token: Tokens.Table; depth: number }): JSX.Element {
  const cellAlign = (index: number) => align[props.token.align[index] ?? "left"] ?? "text-start";
  return (
    <div class="min-w-0 overflow-x-auto">
      <table class="w-full border-collapse text-row">
        <thead>
          <tr>
            <For each={props.token.header}>
              {(cell, index) => (
                <th
                  class={`border-b border-edge-strong py-2 pe-4 text-label text-ink-3 ${cellAlign(index())}`}
                >
                  <Inline tokens={cell.tokens} depth={props.depth + 1} />
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.token.rows}>
            {(row) => (
              <tr>
                <For each={row}>
                  {(cell, index) => (
                    <td class={`border-b border-edge py-2 pe-4 align-top ${cellAlign(index())}`}>
                      <Inline tokens={cell.tokens} depth={props.depth + 1} />
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

function safeHref(href: string): string | undefined {
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : undefined;
}

function inline(token: Token, depth: number): JSX.Element {
  switch (token.type) {
    case "strong":
      return (
        <strong class="font-semibold">
          <Inline tokens={token.tokens} depth={depth + 1} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inline tokens={token.tokens} depth={depth + 1} />
        </em>
      );
    case "del":
      return (
        <del>
          <Inline tokens={token.tokens} depth={depth + 1} />
        </del>
      );
    case "codespan":
      return <code class="rounded-xs bg-hover px-1 font-mono">{decode(token.text)}</code>;
    case "link": {
      const href = safeHref(token.href);
      return href ? (
        <a class="link" href={href} target="_blank" rel="noreferrer">
          <Inline tokens={token.tokens} depth={depth + 1} />
        </a>
      ) : (
        <Inline tokens={token.tokens} depth={depth + 1} />
      );
    }
    case "image":
      return token.text || token.href;
    case "br":
      return <br />;
    case "escape":
    case "text":
      return "tokens" in token && token.tokens ? (
        <Inline tokens={token.tokens} depth={depth + 1} />
      ) : (
        decode(token.text)
      );
    default:
      return "text" in token ? decode(String(token.text)) : token.raw;
  }
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Marked escapes text for HTML; Solid writes text nodes, so undo it. */
export function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (!name.startsWith("#")) return entities[name.toLowerCase()] ?? entity;
    const hex = name[1]?.toLowerCase() === "x";
    const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : "�";
  });
}
