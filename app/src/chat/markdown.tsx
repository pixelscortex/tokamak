import { ErrorBoundary, Index, Show, createEffect, createMemo, on } from "solid-js";
import { Lexer, type Token, type Tokens as MarkedTokens } from "marked";

// CommonMark only: no HTML renderer, DOM APIs, highlighting or GFM extensions.
// The lexer keeps an unfinished fenced block as code throughout streaming.
export function Markdown(props: { text: string }) {
  const tokens = createMemo(() => {
    try {
      return Lexer.lex(props.text, { gfm: false });
    } catch {
      return undefined;
    }
  });
  return <div class="chat-markdown"><ErrorBoundary fallback={(_: unknown, reset: () => void) => {
    createEffect(on(() => props.text, reset, { defer: true }));
    return <>{props.text}</>;
  }}><Show when={tokens()} fallback={props.text}><Tokens tokens={tokens()} depth={0} /></Show></ErrorBoundary></div>;
}

function Tokens(props: { tokens: Token[] | undefined; depth: number }) {
  return <Index each={props.tokens}>{token => <Show when={props.depth < 8} fallback={token().raw}><Show when={token().type === "code"} fallback={<>{renderToken(token(), props.depth)}</>}>
    <pre><code>{(token() as MarkedTokens.Code).text}</code></pre>
  </Show></Show>}</Index>;
}

function renderToken(token: Token, depth: number) {
  switch (token.type) {
    case "space":
    case "def": return null;
    case "paragraph": return <p><Tokens tokens={token.tokens} depth={depth + 1} /></p>;
    case "heading": return <h3 aria-level={token.depth}><Tokens tokens={token.tokens} depth={depth + 1} /></h3>;
    case "strong": return <strong><Tokens tokens={token.tokens} depth={depth + 1} /></strong>;
    case "em": return <em><Tokens tokens={token.tokens} depth={depth + 1} /></em>;
    case "codespan": return <code>{token.text}</code>;
    case "blockquote": return <blockquote><Tokens tokens={token.tokens} depth={depth + 1} /></blockquote>;
    case "list": {
      const items = () => <Index each={token.items}>{item => <li><Tokens tokens={item().tokens} depth={depth + 1} /></li>}</Index>;
      return token.ordered ? <ol start={token.start || 1}>{items()}</ol> : <ul>{items()}</ul>;
    }
    case "link": return <span class="underline"><Tokens tokens={token.tokens} depth={depth + 1} /></span>;
    case "br": return <br />;
    case "hr": return <hr />;
    case "text": return token.tokens ? <Tokens tokens={token.tokens} depth={depth + 1} /> : token.text;
    default: return "text" in token ? token.text : token.raw;
  }
}
