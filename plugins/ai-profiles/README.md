# AI Profiles

The Profiles screen. Its Subscriptions section: a person adds a Claude
subscription (company, method, sign-in, connected) and sees it as a card. Its
Profiles section: a person makes a profile (a name and a code of up to four
characters, unique for them) and drags subscription cards into it, in the
order they are used, first one first. The picker column and the launch
settings come with a later ticket (TKM-266).

It depends on `ai` and `agent-proxy`. Subscriptions belong to `agent-proxy`;
this plugin stores only profiles (`src/server/schema.ts`), each one person's,
holding subscription ids. A subscription `agent-proxy` no longer lists drops
out of every profile: readers skip it, the next write deletes it, and the flow
that removes a subscription calls `internal.profiles.forgetSubscription`. Its server functions
(`src/server/subscriptions.ts`) pass the window's calls on to
`agent-proxy`'s plugin-only exports, which answer for the calling member only
and never with a login.

Company logos are the marks of the `claude` and `codex` agent plugins, read
from ai's agent list on this computer (`ui/company-mark.tsx`). A window without a reachable Runner shows a neutral mark.

The screen asks the server to renew logins that run out soon when it opens
and every minute while it stays open (server code has no network timer).

Tests: `moon run ai-profiles:test` (the dialog, the cards, the awaiting card,
the Profiles section with dragging and its keyboard menus, with a stand-in
server; and profiles on a real server, `tests/profiles-server.test.ts`, when
the server and plugin host are built). The same flow runs on a real server against the fake
Claude sign-in in `plugins/agent-proxy/tests/sign-in.test.ts`.

Screens and their Paper copies: `design/ai-profiles.md`.
