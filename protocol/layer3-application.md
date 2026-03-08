# Layer 3: Application Protocol

The application layer defines the methods available for client-gateway interaction. These are carried as `method` and `params` in Layer 2 REQUEST messages, and `event` and `data` in NOTIFY messages.

**This layer is a reference specification.** Clients and gateways may extend it with custom methods. Unknown methods should be rejected with `method_not_found`, not cause a crash.

## Methods

### chat.send

Send a message to an agent and receive a response.

**Request:**

```json
{
  "method": "chat.send",
  "params": {
    "agent": "tangseng",
    "message": "What's the latest news on AI chips?",
    "session_id": null,
    "stream": true
  }
}
```

- `agent`: Agent name. If omitted, uses the default agent.
- `message`: User message text.
- `session_id`: Resume an existing session. `null` to start a new one.
- `stream`: If `true`, gateway responds with STREAM_START/STREAM_CHUNK/STREAM_END. If `false`, responds with a single RESPONSE.

**Streaming Response:**

```json
// stream_chunk data:
{
  "delta": "Based on recent reports, ",
  "session_id": "sess_abc123"
}

// stream_end (final chunk carries metadata):
// followed by a RESPONSE:
{
  "result": {
    "session_id": "sess_abc123",
    "agent": "tangseng",
    "tokens": {"input": 150, "output": 420}
  }
}
```

**Non-streaming Response:**

```json
{
  "result": {
    "content": "Based on recent reports, the AI chip market...",
    "session_id": "sess_abc123",
    "agent": "tangseng",
    "tokens": {"input": 150, "output": 420}
  }
}
```

### agents.list

List available agents.

**Request:**

```json
{
  "method": "agents.list",
  "params": {}
}
```

**Response:**

```json
{
  "result": {
    "agents": [
      {
        "name": "tangseng",
        "display_name": "唐僧",
        "status": "idle",
        "description": "Team lead and coordinator"
      },
      {
        "name": "diting",
        "display_name": "谛听",
        "status": "running",
        "description": "Intelligence analyst"
      }
    ]
  }
}
```

### agents.info

Get detailed info about a specific agent.

**Request:**

```json
{
  "method": "agents.info",
  "params": {
    "agent": "tangseng"
  }
}
```

**Response:**

```json
{
  "result": {
    "name": "tangseng",
    "display_name": "唐僧",
    "status": "idle",
    "description": "Team lead and coordinator",
    "tools": ["web-search", "write-article", "generate-image"],
    "recent_sessions": 5
  }
}
```

### sessions.list

List recent sessions, optionally filtered by agent.

**Request:**

```json
{
  "method": "sessions.list",
  "params": {
    "agent": "tangseng",
    "limit": 20,
    "offset": 0
  }
}
```

**Response:**

```json
{
  "result": {
    "sessions": [
      {
        "id": "sess_abc123",
        "agent": "tangseng",
        "started_at": "2026-03-07T10:30:00Z",
        "last_message_at": "2026-03-07T10:35:22Z",
        "message_count": 8,
        "preview": "Research AI chip developments..."
      }
    ],
    "total": 47
  }
}
```

### sessions.history

Get the message history of a session.

**Request:**

```json
{
  "method": "sessions.history",
  "params": {
    "session_id": "sess_abc123",
    "limit": 50,
    "before": null
  }
}
```

**Response:**

```json
{
  "result": {
    "messages": [
      {
        "role": "user",
        "content": "Research AI chip developments",
        "timestamp": "2026-03-07T10:30:00Z"
      },
      {
        "role": "assistant",
        "content": "Based on my research...",
        "timestamp": "2026-03-07T10:30:45Z"
      }
    ],
    "has_more": false
  }
}
```

### cron.list

List configured cron tasks.

**Request:**

```json
{
  "method": "cron.list",
  "params": {}
}
```

**Response:**

```json
{
  "result": {
    "tasks": [
      {
        "id": "cron_001",
        "name": "Daily news digest",
        "agent": "diting",
        "schedule": "0 8 * * *",
        "enabled": true,
        "last_run": "2026-03-07T08:00:00Z",
        "last_status": "ok"
      }
    ]
  }
}
```

### cron.toggle

Enable or disable a cron task.

**Request:**

```json
{
  "method": "cron.toggle",
  "params": {
    "id": "cron_001",
    "enabled": false
  }
}
```

**Response:**

```json
{
  "result": {
    "id": "cron_001",
    "enabled": false
  }
}
```

### system.status

Get system health information.

**Request:**

```json
{
  "method": "system.status",
  "params": {}
}
```

**Response:**

```json
{
  "result": {
    "version": "2026.3.2",
    "uptime_seconds": 86400,
    "agents_active": 4,
    "cron_tasks": 12,
    "channels": {
      "telegram": "running",
      "discord": "running",
      "relay": "running"
    }
  }
}
```

## Notification Events

Notifications are sent from the gateway to the client via NOTIFY messages. They are one-way — no response is expected.

### agent.output

An agent has produced output (e.g., completed a cron task).

```json
{
  "event": "agent.output",
  "data": {
    "agent": "diting",
    "session_id": "sess_xyz",
    "type": "report",
    "title": "Daily News Digest - 2026-03-07",
    "preview": "Top stories: 1. TSMC announces...",
    "timestamp": "2026-03-07T08:05:00Z"
  }
}
```

### agent.status

An agent's status changed.

```json
{
  "event": "agent.status",
  "data": {
    "agent": "diting",
    "status": "running",
    "task": "Executing daily news search"
  }
}
```

### system.alert

System-level alert (service down, error spike, etc.).

```json
{
  "event": "system.alert",
  "data": {
    "level": "warning",
    "message": "Provider 'major' circuit breaker opened",
    "timestamp": "2026-03-07T14:22:00Z"
  }
}
```

## Extensibility

Clients and gateways may define custom methods and events. Conventions:

- Custom methods: use a namespace prefix, e.g. `x.myapp.custom_action`
- Custom events: use a namespace prefix, e.g. `x.myapp.custom_event`
- Standard methods (without prefix) are reserved for this specification.

This allows users to extend the protocol for their specific needs without conflicting with future standard methods.
