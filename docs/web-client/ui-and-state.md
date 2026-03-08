# Web Client UI and State

This document describes the browser client's DOM structure, application state, and user-visible behavior.

## UI Shape

`client/index.html` is a single-page layout with two major modes:

- **connect panel**
- **chat panel**

### Header

The header contains:

- application title
- connection status dot
- connection status label
- connection details text
- disconnect button

### Connect Panel

The connect form collects:

- saved relay profile selection
- profile name for saving safe settings
- relay URL
- channel token
- gateway public key

It also includes a client-identity card that shows:

- whether a persistent browser identity is available
- the current client fingerprint summary when known
- export, import, and reset actions for browser identity management

The connect panel also displays a connection error box when handshake or WebSocket setup fails.

### Chat Panel

The chat panel contains:

- agent selector
- selected agent status line
- scrollable message list
- multiline message input
- send button

### Toast Layer

Transient status and error notifications are rendered into `#toastContainer`.

## Application State Fields

`app.js` maintains a small explicit state object.

| Field | Meaning |
|-------|---------|
| `connection` | The single `RelayConnection` instance |
| `agents` | Last loaded list from `agents.list` |
| `profiles` | Saved relay profiles loaded from `localStorage` |
| `sessionId` | Current Layer 3 chat session id, if any |
| `currentStreamEl` | Active DOM node for the assistant stream in progress |
| `currentStreamText` | Accumulated assistant text during streaming |

Identity metadata itself is owned by `connection`; `app.js` only renders it.

## Boot Flow

On `DOMContentLoaded`:

1. the app cleans any historical `channelToken` from persisted settings
2. the app restores the selected saved profile or the last safe custom settings
3. the app wires transport callbacks
4. the send button becomes input-driven and connection-aware
5. the app hydrates any persisted browser identity
6. the connect panel renders the current identity status, fingerprint summary, and identity actions

## Profile Management Flow

`app.js` manages named saved relay profiles containing only non-secret fields.

### Save profile

`app.saveProfile()`:

- validates that `relayUrl` and `gatewayPubKey` are present
- normalizes the relay URL for storage
- updates the selected profile or creates a new one
- persists the profile list to `openclaw-relay-profiles`
- persists the selected profile id in safe settings

### Select profile

`app.handleProfileSelectChange()`:

- applies the chosen profile to the connect form
- keeps `channelToken` untouched because it is never stored
- updates the selected profile id in safe settings

### Delete profile

`app.deleteProfile()`:

- requires a selected saved profile
- asks for confirmation before deletion
- removes that profile from `openclaw-relay-profiles`
- keeps the current connect form in custom/unsaved mode afterwards

## Connect Flow

When the user submits the connect form:

1. required fields are validated for non-empty input
2. the relay URL is normalized to end with `/ws` if needed
3. safe settings are saved
4. the button moves to a `Connecting...` state
5. `RelayConnection.connect()` runs
6. on success:
   - connect panel is hidden
   - chat panel is shown
   - agent list is fetched
   - a system message announces encrypted connection
   - the identity card is refreshed with the active fingerprint summary
7. on failure:
   - the connect error panel is populated
   - the form remains visible
   - any newly created identity still remains available for the next attempt

## Disconnect Flow

`app.disconnect()`:

- calls `connection.disconnect()`
- returns the page to connect mode
- hides the disconnect button
- clears rendered messages
- clears current `sessionId`
- clears the in-memory agent list
- keeps persisted safe settings and the persisted browser identity intact

## Identity Export Flow

`app.exportIdentity()`:

- asks `connection.exportIdentityBundle()` for the current browser identity
- serializes a portable JSON file containing the X25519 keypair and fingerprint metadata
- triggers a browser download from the connect panel
- reminds the user that the exported file is secret material

## Identity Import Flow

`app.handleImportIdentity()`:

- opens a local JSON file chooser from the connect panel
- asks for confirmation before replacing an existing browser identity
- parses the imported identity bundle
- asks `connection.importIdentityBundle()` to validate and install it
- returns the UI to connect mode and refreshes the identity card
- shows whether the imported identity was persisted or is active for this page only

## Identity Reset Flow

`app.resetIdentity()`:

- asks for confirmation before rotating the current browser identity
- disables the reset button while work is in progress
- asks `connection.resetIdentity()` to clear the stored browser identity
- returns the UI to connect mode if needed
- refreshes the identity card
- shows a toast announcing that a new identity will be created on the next connect

This operation intentionally rotates the web client's cryptographic identity.

## Agent State

After connect, `app._fetchAgents()`:

- calls `agents.list`
- populates the `<select>` options
- stores the resulting list in memory
- updates the selected agent status line

The selected agent status text is derived from:

- `agent.status`
- optional `agent.description`

## Chat Flow

When the user sends a message:

1. the message is appended as a user bubble
2. input is cleared
3. an assistant placeholder bubble is created
4. `chat.send` is sent as a streaming request
5. each `stream_chunk.data.delta` is appended to `currentStreamText`
6. assistant text is re-rendered through `renderMarkdown()` on every chunk
7. a cursor marker is shown while streaming is in progress
8. the final `response` may update `sessionId`
9. final text is rendered without the cursor

If the request fails:

- partial streamed content stays visible if any arrived
- otherwise the empty assistant bubble is removed and an error toast is shown

## Notifications

`app.js` currently handles two `notify` events:

| Event | Behavior |
|-------|----------|
| `agent.status` | updates the in-memory agent status and refreshes the selected agent line |
| `system.alert` | shows a warning/error toast |

Unknown notification types are currently ignored by the UI layer.

## Status Indicator Behavior

The status indicator reflects `connection.state`.

| State | Header Label |
|-------|--------------|
| `disconnected` | `Disconnected` |
| `connecting` | `Connecting...` |
| `connected` | `Connected` |

When connected, `statusDetails` shows:

- relay host
- `(encrypted)` when Layer 1 succeeded
- a shortened identity fingerprint when known

The send button is enabled only when:

- the connection state is `connected`
- the message box is non-empty

## Rendering Rules

Message roles are rendered differently:

- `user` messages align to the right
- `assistant` messages align to the left and show the agent name when known
- `system` messages are centered and muted

Assistant text passes through `renderMarkdown()` before insertion.

Agent names are escaped before insertion to avoid UI injection.

## UX Limits Today

The current UI still lacks:

- explicit pairing state display
- persisted local conversation history
- richer diagnostics beyond status text, fingerprint display, and toasts

These are product improvements, not missing protocol primitives.
