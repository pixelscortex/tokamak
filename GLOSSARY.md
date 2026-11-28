# Tokamak

Tokamak is an app for working alone or with others in a workspace shaped by plugins.

## Language

### App and workspace

**Workspace**:
One data store, plugin list, and member list, separate from all other workspaces.
_Avoid_: Space, project, team.

**Client**:
The app a person uses to connect to a server as a member. The desktop client starts a Runner on the person’s computer.
_Avoid_: Frontend.

**Window**:
The visible part of the client in which a person works. It calls functions and never changes data or files directly.
_Avoid_: Client (for the interface alone), frontend, webview.

**Local part**:
The part of a plugin the Runner loads to run caller actions and their contracts. These actions can work with files and programs on the caller’s machine.
_Avoid_: Worker, local server.

**Runner**:
The program that runs a workspace server and its local runtime together. The desktop client starts one; a person can also start one independently.
_Avoid_: Worker, client.

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
_Avoid_: Computer (when referring to the sign-in), session.

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
The role that can manage ordinary members and sign out both their devices and the admin's own devices.
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
The points before and after agent work at which other plugins can act on a turn. They run in the provider’s plugin process; cancellation is delivered to the hook’s own signal.
_Avoid_: Interceptors, middleware, callbacks (when referring to the extension points).

### Plugins

**Contract**:
A named agreement a plugin defines about what another plugin can provide.
_Avoid_: Provider lookup, service name, interface (when referring to the agreement itself).

**Plugin process**:
A process the Runner starts on demand to run one installed build of a plugin's local part.
_Avoid_: Worker, action process (when referring to caller actions).

**Action process**:
A process the server starts to run server actions. Each call starts with fresh module state.

**Plain-data method**:
A local contract method declared to take and return only JSON data. All local contract methods are plain data. Calls to another plugin's methods run in that provider's plugin process.
_Avoid_: Remote method (which can also mean a call to a shared server).

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
The optional collection of plugins in the separate `tokamak-plugins` repository for threads, agents, code review and sign-in.
_Avoid_: Built-ins, core plugins, defaults.

**Plugins folder**:
The one folder the app loads plugin builds from, `plugins` in its data folder, with one child folder per plugin named by its id. The app ships with no plugins and creates the folder when missing.
_Avoid_: Plugin directory, install location, bundle.

Settings → Plugins shows loaded and failed plugins. The same catalog is available
through `GET /plugins` and `tokamak-server plugin list`.

**Install**:
Place a plugin's build in the plugins folder as `<plugins folder>/<id>`, replacing the build that was there. A running app picks it up on reload.
_Avoid_: Deploy, add, enable.

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
