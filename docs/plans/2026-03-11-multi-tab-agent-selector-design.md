# Multi-Tab Chat + Hierarchical Agent Selector Design

## Goal

Replace the single-agent flat-dropdown chat with a tabbed multi-agent interface and grouped agent selector, enabling simultaneous conversations with multiple agents.

## Architecture

The web client gets a tab bar replacing the current agent-bar. Each tab holds an independent conversation (agent, sessionId, transcript, stream state). A custom grouped selector replaces the native `<select>`. The backend adds a `group` field to `agents.list` responses.

## 1. Agent Data Layer

### Backend Change

`agents.list` RPC response adds `group` field:

```json
{
  "agents": [
    { "name": "diting", "display_name": "谛听", "group": "西游记", "status": "idle" },
    { "name": "ins-daiyu", "display_name": "黛玉", "group": "红楼梦", "status": "idle" }
  ]
}
```

Agents without `group` render under "未分组".

### Where to Add

- Gateway plugin: `RelayRuntimeAdapter.agentsList()` return type adds optional `group: string`
- Plugin handler: `handlers/agents.ts` passes through the field
- Go relay: `handler.go` passes through JSON fields transparently (no change needed)

## 2. Tab Bar

Replaces the current `.agent-bar` (`<select>` + status).

### Structure

```
[谛听 ×] [黛玉 ×] [+]
```

- Each tab shows `display_name` (or `name` fallback) + close button
- Active tab highlighted
- `+` button opens the grouped agent selector
- Default: one empty tab on connect (agent not yet chosen)

### Tab State

```javascript
tabs: [
  {
    id: 'tab-1',
    agent: 'diting',        // agent name
    sessionId: null,         // chat session
    transcript: [],          // message history
    streamText: '',          // current stream buffer
    streamEpoch: 0,          // stream cancellation token
    messagesHTML: ''         // cached DOM when tab is inactive
  }
],
activeTabId: 'tab-1',
splitTabId: null             // second tab in split view, or null
```

### Tab Switching

1. Save current tab's `#messages` innerHTML to `messagesHTML`
2. Load target tab's `messagesHTML` into `#messages`
3. Restore input state
4. Update active highlight

## 3. Grouped Agent Selector

Custom popup panel replacing the native `<select>`.

### Layout

```
┌─────────────────────┐
│ 搜索 agent...        │
├─────────────────────┤
│ ▾ 西游记             │
│   谛听  idle         │
│ ▾ 红楼梦             │
│   黛玉  idle         │
│   宝玉  idle         │
│ ▾ 未分组             │
│   some-agent         │
└─────────────────────┘
```

- Groups collapsible, default all expanded
- Search box filters by `name` and `display_name`
- Click agent → open new tab with that agent, switch to it
- Two entry points: tab bar `+` button and direct click from selector

### Rendering

```javascript
// Group agents
const groups = {};
for (const agent of agents) {
  const g = agent.group || '未分组';
  (groups[g] ??= []).push(agent);
}
```

## 4. Split View

- Default: single pane showing `activeTabId`
- Enter split: drag tab to right edge, or Shift+click a tab
- Split view: two side-by-side panes, each with own messages + input
- Exit split: close the split tab, or drag it back to tab bar
- `splitTabId` tracks the right-pane tab

### CSS

```css
.chat-content { display: flex; flex: 1; }
.chat-pane { flex: 1; display: flex; flex-direction: column; }
.chat-pane + .chat-pane { border-left: 1px solid var(--border); }
```

## 5. Message Flow Changes

`sendMessage()` changes:
- Read `agent` from active tab state, not from `<select>`
- Read/write `sessionId` from tab state
- Stream chunks route to the correct tab's DOM (match by tab id, not global)

`startNewChat()` clears only the active tab's state.

## 6. What Doesn't Change

- Transport layer (`sendRequest` / `sendStreamRequest`)
- `chat.send` RPC protocol (already sends `agent` + `session_id` per message)
- Sessions modal, Dashboard, connection details
- Connection/identity management

## 7. Files to Modify

| File | Change |
|------|--------|
| `client/index.html` | Replace `.agent-bar` with tab bar + agent selector panel |
| `client/js/app.js` | Tab state management, grouped selector, split view logic |
| `client/index.html` (CSS) | Tab bar styles, selector panel styles, split pane layout |
| `plugin/src/types.ts` | Add `group?: string` to agent type |
| `plugin/src/handlers/agents.ts` | Pass through `group` field |
