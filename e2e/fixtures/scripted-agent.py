#!/usr/bin/python3
# A scripted ACP agent for browser tests and screenshots. It never calls a model.
# The prompt picks the script: "permission", "fail", "slow" or "markdown";
# anything else gets a short reply after three tool steps.
import json, os, select, sys, time

SPEED = float(os.environ.get("SCRIPTED_AGENT_SPEED", "1"))
inbox = []
cancelled = False
answers = {}


def send(value):
    print(json.dumps(dict(jsonrpc="2.0", **value)), flush=True)


def update(session, **value):
    send(dict(method="session/update", params=dict(sessionId=session, update=value)))


def handle(message):
    global cancelled
    if message.get("method") == "session/cancel":
        cancelled = True
    elif "result" in message or "error" in message:
        answers[message.get("id")] = message
    else:
        inbox.append(message)


buffer = b""


def read_line(timeout):
    """One line from stdin, or None after the timeout; Python's buffered stdin hides lines from select."""
    global buffer
    end = None if timeout is None else time.time() + timeout
    while b"\n" not in buffer:
        left = None if end is None else max(0, end - time.time())
        ready, _, _ = select.select([0], [], [], left)
        if not ready:
            return None
        chunk = os.read(0, 65536)
        if not chunk:
            sys.exit(0)
        buffer += chunk
    line, buffer = buffer.split(b"\n", 1)
    return line.decode()


def wait(seconds):
    """Sleeps while still reading cancel notifications and permission answers."""
    end = time.time() + seconds * SPEED
    while not cancelled:
        left = end - time.time()
        if left <= 0:
            return
        line = read_line(left)
        if line and line.strip():
            handle(json.loads(line))


def stream(session, text, chunk=6, delay=0.03):
    words = text.split(" ")
    for start in range(0, len(words), chunk):
        if cancelled:
            return
        piece = " ".join(words[start : start + chunk])
        update(session, sessionUpdate="agent_message_chunk", content=dict(type="text", text=piece + (" " if start + chunk < len(words) else "")))
        wait(delay)


def tool(session, call, title, kind, seconds, status="completed"):
    update(session, sessionUpdate="tool_call", toolCallId=call, title=title, kind=kind, rawInput=dict(step=title))
    update(session, sessionUpdate="tool_call_update", toolCallId=call, status="in_progress")
    wait(seconds)
    if cancelled:
        return
    update(session, sessionUpdate="tool_call_update", toolCallId=call, status=status, content=[dict(type="content", content=dict(type="text", text=f"{title}: ok"))])


def plan(session, entries):
    update(session, sessionUpdate="plan", entries=[dict(content=c, status=s, priority="medium") for c, s in entries])


def ask(session, call, title):
    send(dict(id=f"permission-{call}", method="session/request_permission", params=dict(
        sessionId=session,
        toolCall=dict(toolCallId=call, title=title),
        options=[
            dict(optionId="allow", name="Allow", kind="allow_once"),
            dict(optionId="always", name="Always allow", kind="allow_always"),
            dict(optionId="deny", name="Deny", kind="reject_once"),
        ],
    )))
    while not cancelled and f"permission-{call}" not in answers:
        wait(0.1)
    answer = answers.get(f"permission-{call}", {}).get("result", {}).get("outcome", {})
    return answer.get("optionId") if answer.get("outcome") == "selected" else None


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
    session = request["params"]["sessionId"]
    text = request["params"]["prompt"][0].get("text", "")
    lowered = text.lower()
    if "fail" in lowered:
        tool(session, "read", "Read package.json", "read", 0.4)
        send(dict(id=request["id"], error=dict(code=-32000, message="The model is overloaded. Try again in a minute.")))
        return
    if "slow" in lowered:
        plan(session, [("Read the failing test", "in_progress"), ("Fix the cache", "pending"), ("Run the tests", "pending")])
        tool(session, "slow-read", "Reading session.test.ts", "read", 2)
        plan(session, [("Read the failing test", "completed"), ("Fix the cache", "in_progress"), ("Run the tests", "pending")])
        tool(session, "slow-test", "Running pnpm test auth", "execute", 60)
        stop = "cancelled" if cancelled else "end_turn"
        send(dict(id=request["id"], result=dict(stopReason=stop)))
        return
    if "permission" in lowered:
        tool(session, "inspect", "Read src/auth/session.ts", "read", 0.5)
        choice = ask(session, "push", "git push origin fix/session-refresh")
        if cancelled:
            send(dict(id=request["id"], result=dict(stopReason="cancelled")))
            return
        if choice in ("allow", "always"):
            tool(session, "push", "Pushing fix/session-refresh", "execute", 0.6)
            stream(session, "Pushed `fix/session-refresh`. The branch is ready for review.")
        else:
            stream(session, "Understood, I did not push. The change is committed locally on `fix/session-refresh`.")
        send(dict(id=request["id"], result=dict(stopReason="end_turn")))
        return
    if "markdown" in lowered:
        tool(session, "md-read", "Read src/auth/session.ts", "read", 0.3)
        tool(session, "md-edit", "Edited src/auth/session.ts", "edit", 0.3)
        tool(session, "md-test", "Ran pnpm test auth", "execute", 0.4)
        plan(session, [("Refresh the cached token with the session", "completed"), ("Run the auth tests", "completed"), ("Open a pull request", "pending")])
        stream(session, MARKDOWN, chunk=4, delay=0.02)
        send(dict(id=request["id"], result=dict(stopReason="cancelled" if cancelled else "end_turn")))
        return
    tool(session, "look", "Listed the project files", "read", 0.4)
    tool(session, "search", "Searched for refresh(", "search", 0.4)
    tool(session, "open", "Read README.md", "read", 0.3)
    stream(session, "This is a Tokamak workspace: a Rust server runs TypeScript plugins, and the desktop client renders their views. Chat is the core plugin; agents reach it through the ACP plugin.")
    send(dict(id=request["id"], result=dict(stopReason="cancelled" if cancelled else "end_turn")))


while True:
    line = read_line(None)
    if line and line.strip():
        handle(json.loads(line))
    while inbox:
        request = inbox.pop(0)
        method = request.get("method")
        params = request.get("params", {})
        if method == "initialize":
            send(dict(id=request["id"], result=dict(protocolVersion=1, authMethods=[], agentCapabilities=dict(loadSession=True))))
        elif method in ("session/new", "session/load", "session/resume"):
            send(dict(id=request["id"], result=dict(sessionId=params.get("sessionId", "scripted"))))
        elif method == "session/prompt":
            cancelled = False
            run(request)
        elif "id" in request:
            send(dict(id=request["id"], error=dict(code=-32601, message="Method not found")))
