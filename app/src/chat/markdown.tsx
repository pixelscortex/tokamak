import { Index, Show, createMemo } from "solid-js";
import { Lexer, type Token, type Tokens as MarkedTokens } from "marked";

// CommonMark only: no HTML renderer, DOM APIs, highlighting or GFM extensions.
// The lexer keeps an unfinished fenced block as code throughout streaming.
export function Markdown(props: { text: string }) {
  const tokens = createMemo(() => Lexer.lex(props.text, { gfm: false }));
  return <div class="chat-markdown"><Tokens tokens={tokens()} /></div>;
}

function Tokens(props: { tokens: Token[] | undefined }) {
  return <Index each={props.tokens}>{token => <Show when={token().type === "code"} fallback={<>{renderToken(token())}</>}>
    <pre><code>{(token() as MarkedTokens.Code).text}</code></pre>
  </Show>}</Index>;
}

function renderToken(token: Token) {
  switch (token.type) {
    case "space":
    case "def": return null;
    case "paragraph": return <p><Tokens tokens={token.tokens} /></p>;
    case "heading": return <h3 aria-level={token.depth}><Tokens tokens={token.tokens} /></h3>;
    case "strong": return <strong><Tokens tokens={token.tokens} /></strong>;
    case "em": return <em><Tokens tokens={token.tokens} /></em>;
    case "codespan": return <code>{token.text}</code>;
    case "blockquote": return <blockquote><Tokens tokens={token.tokens} /></blockquote>;
    case "list": {
      const items = () => <Index each={token.items}>{item => <li><Tokens tokens={item().tokens} /></li>}</Index>;
      return token.ordered ? <ol start={token.start || 1}>{items()}</ol> : <ul>{items()}</ul>;
    }
    case "link": return <span class="underline"><Tokens tokens={token.tokens} /></span>;
    case "br": return <br />;
    case "hr": return <hr />;
    case "text": return token.tokens ? <Tokens tokens={token.tokens} /> : token.text;
    default: return "text" in token ? token.text : token.raw;
  }
}
