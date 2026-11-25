# AI Profiles

The Profiles screen. Today it holds the Subscriptions section: a person adds a
Claude subscription (company, method, sign-in, connected) and sees it as a
card. Profiles themselves, the picker column and the launch settings come with
later tickets (TKM-264, TKM-266).

It depends on `ai` and `agent-proxy`. Subscriptions belong to `agent-proxy`;
this plugin stores nothing about them. Its server functions
(`src/server/subscriptions.ts`) pass the window's calls on to
`agent-proxy`'s plugin-only exports, which answer for the calling member only
and never with a login.

Company logos are the marks of the `claude` and `codex` agent plugins, read
from ai's agent list on this computer (`ui/company-mark.tsx`). A plain browser
has no local part and shows a neutral mark.

The screen asks the server to renew logins that run out soon when it opens
and every minute while it stays open (server code has no network timer).

Tests: `moon run ai-profiles:test` (the dialog, the cards, the awaiting card,
with a stand-in server). The same flow runs on a real server against the fake
Claude sign-in in `plugins/agent-proxy/tests/sign-in.test.ts`.

Screens and their Paper copies: `design/ai-profiles.md`.
