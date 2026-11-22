# Tokamak

Tokamak is an app for working alone or with others in a workspace shaped by plugins.

## Language

### App and workspace

**Workspace**:
One data store, plugin list, and member list, separate from all other workspaces.
_Avoid_: Space, project, team.

**Client**:
The window and local part together, connected to a server as a member.
_Avoid_: Frontend, desktop (when both parts are meant).

**Window**:
The visible part of the client in which a person works. It calls functions and never changes data or files directly.
_Avoid_: Client (for the interface alone), frontend, webview.

**Local part**:
The part of the client that can work with files and programs on the person's computer.
_Avoid_: Runner, worker, local server.

**Server**:
The program that runs one workspace and holds its shared data.
_Avoid_: Hub, backend, host.

**Server part**:
The part of a plugin that defines and works with data on the server.
_Avoid_: Backend, local part.

**Local server**:
A server on the person's own computer with that person as its only member.
_Avoid_: This Mac, embedded server, local part.

**Shared server**:
A server that several members can connect to, with its own workspace.
_Avoid_: Remote, cloud server, hub.

### Identity

**Device**:
One signed-in client identity for a member on a server.
_Avoid_: Computer (when referring to the sign-in), session, runner.

**Device key**:
A revocable credential that signs in one device as a member.
_Avoid_: Session token, invite key, owner key.

**Owner key**:
The server's recovery credential, which can restore owner access independently of the sign-in plugin.
_Avoid_: Admin password, device key, invite key.

**Member**:
A person who belongs to a workspace and can sign in to its server.
_Avoid_: Account, device, user (when workspace membership is meant).

**Owner role**:
The role that controls the workspace and can change other members' roles.
_Avoid_: Superadmin, root, operator.

**Admin role**:
The role that can manage ordinary members and sign out devices.
_Avoid_: Owner, moderator.

**Member role**:
The ordinary workspace role, with no authority to manage other members.
_Avoid_: Guest, viewer, ordinary user.

**Sign-in plugin**:
A plugin that verifies sign-in details for the server.
_Avoid_: Identity provider (when the plugin itself is meant), login backend, auth server.

### Agent work

**Agent**:
A program such as Claude or Codex that answers a thread message on the sender's computer using the sender's own login.
_Avoid_: Backend, assistant, bot, persona.

**Thread**:
A conversation that holds a sequence of messages and agent replies. Only one turn can write to a thread at a time, and only the sender's device may write that turn.
_Avoid_: Session, chat (when one conversation is meant).

**Turn**:
One message sent to an agent and the work and reply it produces in the thread.
_Avoid_: Job, request, session.

**Reply**:
The agent's answer to a message, shown in the thread as it arrives.
_Avoid_: Completion, response (when the thread item is meant).

**Step**:
One action the agent takes during a turn, such as running a command or editing a file.
_Avoid_: Event, tool call, task (when one action is meant).

**Access level**:
The rule for when an agent asks before acting: Full access or Ask first.
_Avoid_: Permission mode, sandbox, autonomy.

**Permission question**:
A request from an agent for the sender to decide whether an action may proceed.
_Avoid_: Prompt, approval request, permission (alone).

**Snapshot**:
A saved picture of the thread folder before or after a turn, used to see what changed.
_Avoid_: Checkpoint, backup, diff.

**Turn hooks**:
The points before and after agent work at which other plugins can act on a turn.
_Avoid_: Interceptors, middleware, callbacks (when referring to the extension points).

### Plugins

**Contract**:
A named agreement a plugin defines about what another plugin can provide.
_Avoid_: Provider lookup, service name, interface (when referring to the agreement itself).

**Page**:
A screen at a route in the window, declared with `view`. Its components expose the elements other plugins can extend.
_Avoid_: Component (when the screen is meant), pane.

**Component**:
A reusable piece of the window whose owner can expose elements for other plugins to extend.
_Avoid_: Slot, widget, view.

**Element**:
A named piece of a component that another plugin can target; the owner can name it explicitly with `part`.
_Avoid_: Slot, component (when the target is meant).

**State**:
A value held by the window, optionally kept per device or per member.
_Avoid_: Database row, settings (when referring to state as a whole).

**Starter set**:
The plugins shipped together so a fresh local server can run threads, agents, code review, and sign-in.
_Avoid_: Built-ins, core plugins, defaults.

**Reload**:
Rebuild a plugin and swap it into the running workspace when ready.
_Avoid_: Refresh, redeploy, restart.

**Remount**:
Recreate a plugin's pages and their components while keeping the window open.
_Avoid_: Refresh, window reload.

**Build id**:
The identifier of one exact plugin build. It is the SHA-256 of the built plugin’s `manifest.json`.
_Avoid_: Version, revision (when referring to one build).

**Plugin log**:
A file in the computer's temporary folder for the messages and errors of one plugin on the server and in the window. Reloading the plugin empties its log.
_Avoid_: Console, server log, output.

**Skill file**:
The instructions in a plugin folder that teach an agent how to work on the plugin.
_Avoid_: Prompt, rules file.
