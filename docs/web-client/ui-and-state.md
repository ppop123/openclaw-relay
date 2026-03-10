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
- disconnect button

### Connect Panel

The connect form is split into four layers:

- **L0 Pairing Link**: a primary pairing-link input, connect button, connect error, and a one-line browser-identity summary
- **L1 Manual Setup**: a collapsible fallback section for relay URL, channel token, and gateway public key
- **L2 Saved Profiles**: a collapsible section for saved relay profiles, with an empty state when no profiles exist yet
- **L3 Browser Identity**: a collapsible identity-management section with copy, export, import, reset, and passphrase controls

The browser can also pre-fill the connect fields from a pairing fragment in the page URL. After reading those values, it immediately clears the fragment from the address bar. Users may also paste a full pairing link into the visible `Pairing link` field; the app expands nothing by default and fills the underlying manual fields on demand.

The browser-identity section shows:

- whether a persistent browser identity is available
- the current client fingerprint summary when known
- copy, export, import, and reset actions for browser identity management
- a recovery hint that explains whether the identity is durable, temporary, or needs operator intervention
- an optional passphrase field used only while exporting/importing identity files

The connect panel also displays a connection error box when handshake or WebSocket setup fails.

### Chat Panel

The chat panel contains:

- agent selector
- selected agent status line
- a compact status bar
- an inline profile-save banner when the current connection is not yet saved
- expandable connection details
- scrollable message list
- multiline message input
- send button
- `Save conversation` button for current-transcript download
- `New chat` button for local session reset

### Toast Layer

Transient status and error notifications are rendered into `#toastContainer`.

## Application State Fields

`app.js` maintains a small explicit state object.

| Field | Meaning |
|-------|---------|
| `connection` | The single `RelayConnection` instance |
| `agents` | Last loaded list from `agents.list` |
| `profiles` | Saved relay profiles loaded from `localStorage` |
| `selectedAgentPreference` | Last preferred agent name loaded from safe settings |
| `sessionId` | Current Layer 3 chat session id, if any |
| `currentStreamEl` | Active DOM node for the assistant stream in progress |
| `currentStreamText` | Accumulated assistant text during streaming |

Identity metadata itself is owned by `connection`; `app.js` only renders it.

## Boot Flow

On `DOMContentLoaded`:

1. the app checks the browser URL fragment for pairing handoff values and, when present, fills the connect form then clears the fragment from the address bar
2. the app cleans any historical `channelToken` from persisted settings
3. the app restores the selected saved profile or the last safe custom settings unless pairing handoff already supplied the connect values
4. if the user pastes a full pairing link into the visible field, the app derives the underlying connection values without persisting the bearer secret
4. the app wires transport callbacks
5. the send button becomes input-driven and connection-aware
6. the app hydrates any persisted browser identity
7. the connect panel renders the current identity status, summary line, recovery hint, and identity actions

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

1. if a pairing link is present, the app parses it into the underlying connection fields first
2. required fields are validated for non-empty input
3. the relay URL is normalized to end with `/ws` if needed
4. safe settings are saved
5. the button moves to a `Connecting…` state
6. `RelayConnection.connect()` runs
7. on success:
   - connect panel is hidden
   - chat panel is shown
   - agent list is fetched
   - a system message announces a secure connection to the user's OpenClaw
   - the identity card is refreshed with the active fingerprint summary
   - the status bar and connection details refresh
   - an inline profile-save banner may appear when this relay + gateway combination is not yet saved
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
- resets the status bar and connection-details values back to connect-mode defaults
- keeps persisted safe settings and the persisted browser identity intact

## Status Bar, Connection Details, and New Chat

`app.exportCurrentChat()`:

- exports the current in-memory transcript only when the local chat panel has messages
- downloads a JSON artifact containing relay URL, client id, session id, and ordered messages
- does not persist the transcript automatically in browser storage

The chat panel status bar shows a human-focused summary:

- `Not connected`, `Connecting…`, or `Connected to <relay-host> · Encrypted · <agent>`
- `New chat` and `Save conversation` actions on the right

The expandable connection-details panel separately shows:

- the current `sessionId` or `New chat`
- the current relay-side `clientId`
- the selected saved profile name or `Custom / unsaved`
- a shortened summary of the pinned gateway public key
- current encryption state and browser identity durability

`app.startNewChat()`:

- requires an active connected session
- clears the rendered transcript in the current tab
- resets local `sessionId` to `null`
- keeps the relay connection, selected agent, and browser identity intact
- updates the status bar and connection details immediately

## Identity Copy Flow

`app.copyIdentityFingerprint()` and `app.copyIdentityPublicKey()`:

- read the current identity summary from `RelayConnection`
- copy the full fingerprint or public key to the browser clipboard when available
- leave the buttons disabled until the corresponding value exists
- show an error toast if the browser cannot access the clipboard

## Identity Export Flow

`app.exportIdentity()`:

- asks `connection.exportIdentityBundle()` for the current browser identity
- serializes a portable JSON file containing the X25519 keypair and fingerprint metadata
- encrypts that file first when the optional passphrase field is populated
- triggers a browser download from the connect panel
- warns before producing an unencrypted export

## Identity Import Flow

`app.handleImportIdentity()`:

- opens a local JSON file chooser from the connect panel
- asks for confirmation before replacing an existing browser identity
- parses the imported identity bundle
- decrypts it first when the selected file is passphrase-protected
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

The selected agent itself is restored from safe settings when possible:

- if the saved `selectedAgent` exists in the latest `agents.list` response, that agent is selected again
- otherwise the UI falls back to the first available agent and updates safe settings

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
9. the status bar and connection details refresh whenever `sessionId` changes
10. final text is rendered without the cursor

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

The header status indicator and chat-panel status bar reflect `connection.state`.

| State | Header Label |
|-------|--------------|
| `disconnected` | `Not connected` |
| `connecting` | `Connecting…` |
| `connected` | `Connected` |

When connected, the chat-panel status bar summarizes the relay host, encryption state, and selected agent.

The expandable connection-details panel separately shows session/client/profile/gateway context plus encryption and identity durability.

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

These are product improvements, not missing protocol primitives.
