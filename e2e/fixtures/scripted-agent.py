#!/usr/bin/python3
# A scripted ACP agent for browser tests and screenshots. It never calls a model.
# The prompt picks the script: "permission", "fail", "slow" or "markdown";
# anything else gets a short reply after three tool steps.
import itertools, json, os, sys, threading, time

SPEED = float(os.environ.get("SCRIPTED_AGENT_SPEED", "1"))
out = threading.Lock()
answered = threading.Condition()
answers = {}
cancels = {}
sessions = itertools.count(1)


def send(value):
    with out:
        print(json.dumps(dict(jsonrpc="2.0", **value)), flush=True)


def update(session, **value):
    send(dict(method="session/update", params=dict(sessionId=session, update=value)))


class Turn:
    """One prompt on its own thread, so sessions run side by side like a real agent."""

    def __init__(self, session):
        self.session = session
        self.cancelled = threading.Event()
        cancels[session] = self.cancelled

    def wait(self, seconds):
        self.cancelled.wait(seconds * SPEED)


def stream(turn, text, chunk=6, delay=0.03):
    words = text.split(" ")
    for start in range(0, len(words), chunk):
        if turn.cancelled.is_set():
            return
        piece = " ".join(words[start : start + chunk])
        update(turn.session, sessionUpdate="agent_message_chunk", content=dict(type="text", text=piece + (" " if start + chunk < len(words) else "")))
        turn.wait(delay)


def tool(turn, call, title, kind, seconds, status="completed"):
    update(turn.session, sessionUpdate="tool_call", toolCallId=call, title=title, kind=kind, rawInput=dict(step=title))
    update(turn.session, sessionUpdate="tool_call_update", toolCallId=call, status="in_progress")
    turn.wait(seconds)
    if turn.cancelled.is_set():
        return
    update(turn.session, sessionUpdate="tool_call_update", toolCallId=call, status=status, content=[dict(type="content", content=dict(type="text", text=f"{title}: ok"))])


def plan(turn, entries):
    update(turn.session, sessionUpdate="plan", entries=[dict(content=c, status=s, priority="medium") for c, s in entries])


def ask(turn, call, title):
    key = f"permission-{turn.session}-{call}"
    send(dict(id=key, method="session/request_permission", params=dict(
        sessionId=turn.session,
        toolCall=dict(toolCallId=call, title=title),
        options=[
            dict(optionId="allow", name="Allow", kind="allow_once"),
            dict(optionId="always", name="Always allow", kind="allow_always"),
            dict(optionId="deny", name="Deny", kind="reject_once"),
        ],
    )))
    with answered:
        while key not in answers and not turn.cancelled.is_set():
            answered.wait(0.1)
    outcome = answers.get(key, {}).get("result", {}).get("outcome", {})
    return outcome.get("optionId") if outcome.get("outcome") == "selected" else None


MARKDOWN = """## What changed

The session cache now refreshes **together** with the token, so `Session.current` never holds a stale value. Two small changes, no change to the public API:

1. `refresh()` replaces the cached token in the same step.
2. The test compares against the fresh value.

- Kept the old `expiresAt` field for callers that read it
- Added one test for the race

```ts
export function refresh(session: Session) {
  const token = issue(session.user);
  session.cache.set("token", token);
  return token;
}
```

| File | Lines |
| --- | ---: |
| src/auth/session.ts | +6 −2 |
| src/auth/session.test.ts | +1 −1 |

> The cache was right to exist; it just outlived the token.

See [the ACP spec](https://agentclientprotocol.com) for how tools report progress."""


def run(request):
    turn = Turn(request["params"]["sessionId"])
    finish = lambda: send(dict(id=request["id"], result=dict(stopReason="cancelled" if turn.cancelled.is_set() else "end_turn")))
    text = request["params"]["prompt"][0].get("text", "")
    # Only the newest line picks the script; earlier lines can carry conversation history.
    lowered = (text.strip().splitlines() or [""])[-1].lower()
    if "fail" in lowered:
        tool(turn, "read", "Read package.json", "read", 0.4)
        send(dict(id=request["id"], error=dict(code=-32000, message="The model is overloaded. Try again in a minute.")))
        return
    if "slow" in lowered:
        plan(turn, [("Read the failing test", "in_progress"), ("Fix the cache", "pending"), ("Run the tests", "pending")])
        tool(turn, "slow-read", "Reading session.test.ts", "read", 2)
        plan(turn, [("Read the failing test", "completed"), ("Fix the cache", "in_progress"), ("Run the tests", "pending")])
        tool(turn, "slow-test", "Running pnpm test auth", "execute", 60)
        finish()
        return
    if "permission" in lowered:
        tool(turn, "inspect", "Read src/auth/session.ts", "read", 0.5)
        choice = ask(turn, "push", "git push origin fix/session-refresh")
        if turn.cancelled.is_set():
            finish()
            return
        if choice in ("allow", "always"):
            tool(turn, "push", "Pushing fix/session-refresh", "execute", 0.6)
            stream(turn, "Pushed `fix/session-refresh`. The branch is ready for review.")
        else:
            stream(turn, "Understood, I did not push. The change is committed locally on `fix/session-refresh`.")
        finish()
        return
    if "markdown" in lowered:
        tool(turn, "md-read", "Read src/auth/session.ts", "read", 0.3)
        tool(turn, "md-edit", "Edited src/auth/session.ts", "edit", 0.3)
        tool(turn, "md-test", "Ran pnpm test auth", "execute", 0.4)
        plan(turn, [("Refresh the cached token with the session", "completed"), ("Run the auth tests", "completed"), ("Open a pull request", "pending")])
        stream(turn, MARKDOWN, chunk=4, delay=0.02)
        finish()
        return
    tool(turn, "look", "Listed the project files", "read", 0.4)
    tool(turn, "search", "Searched for refresh(", "search", 0.4)
    tool(turn, "open", "Read README.md", "read", 0.3)
    stream(turn, "This is a Tokamak workspace: a Rust server runs TypeScript plugins, and the desktop client renders their views. Chat is the core plugin; agents reach it through the ACP plugin.")
    finish()



for line in sys.stdin:
    if not line.strip():
        continue
    message = json.loads(line)
    method = message.get("method")
    params = message.get("params", {})
    if "result" in message or "error" in message:
        with answered:
            answers[message.get("id")] = message
            answered.notify_all()
    elif method == "session/cancel":
        cancels.get(params.get("sessionId"), threading.Event()).set()
    elif method == "initialize":
        send(dict(id=message["id"], result=dict(protocolVersion=1, authMethods=[], agentCapabilities=dict(loadSession=True))))
    elif method == "session/new":
        send(dict(id=message["id"], result=dict(sessionId=f"scripted-{next(sessions)}")))
    elif method in ("session/load", "session/resume"):
        send(dict(id=message["id"], result=dict(sessionId=params.get("sessionId"))))
    elif method == "session/prompt":
        threading.Thread(target=run, args=(message,), daemon=True).start()
    elif "id" in message:
        send(dict(id=message["id"], error=dict(code=-32601, message="Method not found")))
