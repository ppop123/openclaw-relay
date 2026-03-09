[中文](#中文) | [English](#english)

---

## 中文

# 技术设计文档

> 本文档描述 OpenClaw Relay 的架构设计。核心技术栈（Go relay 服务端、Python SDK、浏览器参考客户端）已实现并通过测试。细节可能随项目发展而调整。

## 1. 项目概述

OpenClaw Relay 是一个开源系统，让 NAT 后面的 OpenClaw 实例可以被远程访问，无需依赖第三方聊天平台。

v1 目标是**单节点部署**。集群、联邦和高可用明确不在 v1 范围内。

### 设计目标

- 替代对飞书/Telegram/Discord 的依赖，实现 OpenClaw 远程交互
- 端到端加密（end-to-end encryption）——relay 运营者无法读取用户数据
- 极简自托管：单二进制文件，无需数据库
- 通过社区维护的列表进行公共 relay 发现（relay discovery）
- 可扩展的参考客户端，用户可自行定制

### 非目标

- 不是托管服务（没有官方 relay）
- 不是完整产品（客户端只是参考实现）
- 不替代 OpenClaw 本身（relay 和客户端不包含 AI 逻辑）

### 非功能性需求（v1 目标）

| 需求 | 目标值 |
|------|--------|
| 每个 relay 并发频道数 | 500 |
| 每个频道客户端数 | 10 |
| 每个频道消息吞吐量 | 100 msg/s |
| 最大负载大小 | 1 MB |
| Relay 重启恢复 | 客户端 60s 内重连（指数退避） |
| 每个频道内存占用 | ~10 KB |
| 基础内存占用 | ~50 MB |
| /status 响应时间 | < 100ms |

### 架构约束

- v1 目标是每个部署**单个 relay 节点**。水平集群和共享 relay 状态不在首版实现范围内。
- **端到端加密、显式配对和每连接会话密钥唯一性是 MVP 需求**，不是后续增强。
- 网关（gateway）仅在用户主动发起的**配对模式（pairing mode）**期间接受新客户端密钥；配对模式以外，未知客户端密钥一律拒绝。
- 公共 relay 发现必须在注册表（registry）获取失败时使用缓存的最近已知可用列表和可选的镜像 URL 进行降级。

## 2. 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│                        Client App                            │
│                                                              │
│  ┌────────────────────┐    ┌──────────────────────────────┐ │
│  │  Connection Mgr    │    │      Application UI          │ │
│  │                    │    │                              │ │
│  │  ┌──────┐ ┌─────┐ │    │  Chat, Agents, Sessions,    │ │
│  │  │Direct│ │Relay│ │    │  Cron, Files, ...            │ │
│  │  │(LAN) │ │(WAN)│ │    │  (users customize this)     │ │
│  │  └──────┘ └─────┘ │    └──────────────────────────────┘ │
│  └────────────────────┘                                      │
└──────────────┬───────────────────────────────────────────────┘
               │
               │  WSS (or direct local transport with the same Layer 1 security model)
               │
┌──────────────▼───────────────┐
│        Relay Server          │
│                              │
│  • Channel matching (by      │
│    token hash)               │
│  • Presence tracking         │
│  • Heartbeat                 │
│  • Rate limiting             │
│  • Structured logging        │
│  • Abuse controls            │
│  • /status health endpoint   │
│                              │
│  Does NOT:                   │
│  • Parse message content     │
│  • Store any data to disk    │
│  • Require a database        │
│  • Know about agents/chat    │
└──────────────┬───────────────┘
               │  WSS
               │
┌──────────────▼───────────────────────────────────────────────┐
│                     OpenClaw Gateway                          │
│                                                              │
│  ┌────────────────────────────────────────┐                  │
│  │         Relay Channel Plugin           │                  │
│  │                                        │                  │
│  │  • Connects outbound to relay          │                  │
│  │  • E2E encryption / decryption         │                  │
│  │  • Translates relay protocol to        │                  │
│  │    gateway API calls                   │                  │
│  │  • Sends notifications to clients      │                  │
│  └────────────────┬───────────────────────┘                  │
│                   │  localhost HTTP                           │
│  ┌────────────────▼───────────────────────┐                  │
│  │        Gateway API (unchanged)         │                  │
│  └────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────┘
```

## 3. 组件规格

### 3.1 Relay 服务端

**语言**：Go（单个静态二进制文件，可交叉编译到所有平台）

**依赖**：仅标准库（net/http, crypto/tls, nhooyr.io/websocket）

**部署**：
- 从源码构建：`cd relay && go build -o openclaw-relay`
- 运行：`./openclaw-relay --tls auto --domain relay.example.com`

**配置**（仅 CLI 参数，无配置文件）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | 8443 | 监听端口 |
| `--tls` | off | TLS 模式：`off`、`auto`（ACME/Let's Encrypt）或 `manual` |
| `--cert` | — | TLS 证书路径（`--tls manual` 时使用） |
| `--key` | — | TLS 密钥路径（`--tls manual` 时使用） |
| `--max-channels` | 500 | 最大并发频道数 |
| `--max-clients-per-channel` | 10 | 每频道最大客户端数 |
| `--rate-limit` | 100 | 每频道每秒消息数 |
| `--max-payload` | 1048576 | 最大负载大小（字节），默认 1 MB |
| `--public` | false | 在 /status 中公示为公共 relay |
| `--domain` | — | 域名（用于 ACME TLS） |
| `--log-format` | `text` | 日志格式：`text` 或 `json` |

**内部状态**（全部在内存中，重启即丢失）：

```go
type Relay struct {
    channels map[string]*Channel  // key: channel_hash
}

type Channel struct {
    gateway *websocket.Conn
    clients map[string]*websocket.Conn  // key: client_id
}
```

**预估代码量**：300–500 行 Go 代码。

### 3.2 OpenClaw 频道插件

**集成方式**：与飞书频道插件相同的模式——注册为一个频道（channel），从网关消息总线接收消息，发送回复。

**职责**：
1. 启动时：连接到 relay（指定地址或自动发现）
2. 用 token hash 注册频道
3. 处理端到端加密（Layer 1）
4. 用户运行 `openclaw relay pair` 时进入配对模式，批准一个新的客户端密钥并持久化
5. 将 relay 协议请求转换为网关 API 调用
6. 将网关事件（定时任务完成、Agent 输出等）作为通知推送给已连接的客户端

**配置**（在 `openclaw.json` 中）：

```json5
{
  channels: {
    relay: {
      enabled: true,
      // Explicit relay server (optional — auto-discover if omitted)
      server: "wss://my-relay.example.com",
      // Generated on first enable
      channelToken: "kx8f-a3mv-9pqz",
      // Gateway's X25519 private key (generated on first enable)
      privateKey: "base64(...)",
      // Approved client public keys
      clients: {
        "client_uuid_1": {
          publicKey: "base64(...)",
          name: "My Phone",
          addedAt: "2026-03-07T10:00:00Z"
        }
      }
    }
  }
}
```

**CLI 命令**：

```bash
# Enable relay channel (generates keys, discovers relay)
openclaw relay enable [--server wss://...]

# Show pairing code / QR for a new client
openclaw relay pair

# List connected clients
openclaw relay clients

# Revoke a client
openclaw relay revoke <client_id>

# Disable relay
openclaw relay disable
```

### 3.3 参考客户端

**技术栈**：单页 Web 应用（原生 JS 或轻量框架）

**部署**：
- 作为静态文件托管（GitHub Pages、任意 CDN，或本地 `file://`）

**核心功能**（参考实现）：
- 连接到 relay 或直连网关
- 配对（扫码或手动输入）
- 向 Agent 发送消息，接收流式响应
- Agent 输出的 Markdown 渲染
- 异步结果通知收件箱（定时任务、后台任务）
- 基础会话历史浏览

**刻意不包含的功能**（留给用户自行实现）：
- Agent 配置界面
- 文件管理
- 定时任务编辑器
- 系统监控面板
- 自定义主题/品牌

### 3.4 SDK

**Python SDK**（`sdk/python/`）——已实现，协议层 0–2：

```python
from openclaw_relay import RelayClient

client = RelayClient(
    relay="wss://relay.example.com",
    token="kx8f-a3mv-9pqz",
    gateway_public_key="...",
)

async with client.connect() as conn:
    # Chat with streaming
    async for chunk in conn.chat("tangseng", "What is the news today?"):
        print(chunk.delta, end="")

    # List agents
    agents = await conn.agents.list()
```

## 4. 公共 Relay 发现

### 注册表格式

项目仓库中的 `relays.json` 文件：

```json
[
  {
    "url": "wss://relay.alice.dev",
    "region": "cn-east",
    "operator": "alice",
    "operator_url": "https://github.com/alice",
    "capacity": 500,
    "since": "2026-03-01",
    "notes": "Hosted on Aliyun Shanghai"
  }
]
```

### 发现流程

```
1. Plugin loads the last-known-good relay list from local cache (if present)
2. Plugin reads the primary registry URL plus any configured mirrors
3. Fetches and parses the first reachable registry
4. If all registry fetches fail, continue with the cached list and surface a warning
5. For each relay: GET /status (with 5s timeout)
6. Filters: only relays with status.public == true and available capacity
7. Sorts by: latency (primary), available capacity (secondary)
8. Selects the best relay
9. User can override with --server flag
```

OpenClaw 插件应缓存最近已知可用的 relay 列表。如果注册表 URL 不可达，插件使用缓存列表降级，避免 relay 发现出现单点故障。

### 添加公共 Relay

1. 使用 `--public` 参数部署 relay
2. 确保 `/status` 端点可访问
3. Fork 仓库，在 `relays.json` 中添加条目
4. 提交 PR
5. CI 验证 relay 可达且健康
6. 社区审核并合并

### Relay 健康监控

GitHub Action 每日运行：
- 探测 `relays.json` 中所有 relay
- 如果某个 relay 连续 3 天以上不可达，自动开 issue
- 维护者可移除失效的 relay

### 发现机制的韧性

- 注册表格式应保持静态且可缓存，客户端可安全保留一份最近已知可用的副本。
- 公共部署应至少发布一个不在同一托管商的镜像 URL。
- 后续加固步骤应增加签名的注册表清单（signed registry manifest），使客户端能独立于传输层验证数据完整性。

## 5. 安全分析

### 威胁模型（threat model）

| 威胁 | 缓解措施 |
|------|----------|
| Relay 读取消息 | 端到端加密；relay 只能看到密文 |
| Relay 篡改消息 | AES-GCM 认证；篡改可被检测 |
| Relay 重放消息 | 单调递增 nonce 计数器；重放可被检测 |
| 配对时中间人攻击（MITM） | 配对信息通过带外方式传输（QR/手动）；浏览器在握手时验证用户提供的固定网关公钥 |
| 未授权客户端连接 | 频道令牌（channel token）是保密的；未知客户端密钥仅在显式配对模式下被接受 |
| 未授权客户端发送消息 | 端到端加密；没有共享密钥无法解密 |
| 重连后 nonce 重用 | 每次连接使用双方会话 nonce 派生新的会话密钥（session key） |
| Relay 拒绝服务 | 切换到其他 relay；token 和密钥可携带 |
| 网关密钥泄露 | 吊销并重新配对；轮换密钥 |

### Relay 能看到什么

- 某个频道哈希上存在连接
- 网关和客户端的在线/离线状态
- 消息的数量和时间（流量分析）
- 加密负载的大小

### Relay 看不到什么

- 频道令牌（只有哈希值）
- 消息内容
- 用户身份（运行 relay 不需要认证）
- 正在使用哪个 Agent
- 讨论的内容

## 6. 局域网直连

当客户端和 OpenClaw 在同一网络内时，不需要 relay。

### 发现

OpenClaw 网关插件通过 mDNS 广播：

```
Service: _openclaw._tcp.local.
Port: 18789
TXT: version=2026.3.2, relay=enabled
```

客户端应用：
1. 启动时查询 mDNS `_openclaw._tcp.local.`
2. 如果找到，通过网关暴露的本地传输层直接连接
3. 使用相同的 Layer 1 加密（配对时的密钥）
4. 如果 mDNS 失败，降级到 relay 连接

### 无缝切换

客户端中的连接管理器（Connection Manager）维护两条路径：
- 直连（LAN）：更低延迟，不依赖 relay
- Relay（WAN）：在任何网络下可用

当用户在不同网络间移动时，客户端自动切换。应用层（Layer 3）在两种情况下完全相同——只有传输层不同。

## 7. 当前状态

第一阶段（基础 / 安全 MVP）已完成，作为 v0.5.0 发布：

- 协议规范（v1，已冻结）
- Go relay 服务端：频道匹配（channel matching）、转发、/status、滥用控制、结构化日志
- 端到端加密（Layer 1：X25519 + HKDF + AES-256-GCM）
- Python SDK（协议层 0–2）
- OpenClaw relay 频道插件（安全配对、聊天、Agent 间对等发现）
- 浏览器参考客户端（连接、配对、聊天、流式传输）

尚未实现：JavaScript SDK、mDNS 局域网发现、Tauri/移动端封装。

---

## English

# Technical Design Document

> This document describes the architecture of OpenClaw Relay. The core stack (Go relay server, Python SDK, web reference client) is implemented and tested. Details may evolve as the project matures.

## 1. Project Overview

OpenClaw Relay is an open-source system that enables remote access to OpenClaw instances behind NAT, without relying on third-party chat platforms.

v1 targets a **single relay node** deployment. Clustering, federation, and high-availability are explicitly out of scope for v1.

### Goals

- Replace Feishu/Telegram/Discord dependency for OpenClaw remote interaction
- End-to-end encrypted — relay operators cannot read user data
- Trivially self-hostable relay (single binary, no database)
- Public relay discovery via community-curated list
- Extensible reference client that users can customize

### Non-Goals

- Not a managed service (no official relay)
- Not a full-featured product (client is a reference implementation)
- Not a replacement for OpenClaw itself (no AI logic in relay or client)

### Non-Functional Requirements (v1 Targets)

| Requirement | Target |
|-------------|--------|
| Concurrent channels per relay | 500 |
| Clients per channel | 10 |
| Message throughput per channel | 100 msg/s |
| Maximum payload size | 1 MB |
| Relay restart recovery | Clients reconnect within 60s (exponential backoff) |
| Memory per channel | ~10 KB |
| Base memory footprint | ~50 MB |
| /status response time | < 100ms |

### Architectural Constraints

- v1 targets a **single relay node** per deployment. Horizontal clustering and shared relay state are intentionally out of scope for the first implementation.
- **End-to-end encryption, explicit pairing, and per-connection session key uniqueness are MVP requirements**, not later enhancements.
- The gateway only accepts a new client key during an explicit **pairing mode** initiated by the user; outside pairing mode, unknown client keys are rejected.
- Public relay discovery must survive registry fetch failures by using a cached last-known-good list and optional mirror URLs.

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Client App                            │
│                                                              │
│  ┌────────────────────┐    ┌──────────────────────────────┐ │
│  │  Connection Mgr    │    │      Application UI          │ │
│  │                    │    │                              │ │
│  │  ┌──────┐ ┌─────┐ │    │  Chat, Agents, Sessions,    │ │
│  │  │Direct│ │Relay│ │    │  Cron, Files, ...            │ │
│  │  │(LAN) │ │(WAN)│ │    │  (users customize this)     │ │
│  │  └──────┘ └─────┘ │    └──────────────────────────────┘ │
│  └────────────────────┘                                      │
└──────────────┬───────────────────────────────────────────────┘
               │
               │  WSS (or direct local transport with the same Layer 1 security model)
               │
┌──────────────▼───────────────┐
│        Relay Server          │
│                              │
│  • Channel matching (by      │
│    token hash)               │
│  • Presence tracking         │
│  • Heartbeat                 │
│  • Rate limiting             │
│  • Structured logging        │
│  • Abuse controls            │
│  • /status health endpoint   │
│                              │
│  Does NOT:                   │
│  • Parse message content     │
│  • Store any data to disk    │
│  • Require a database        │
│  • Know about agents/chat    │
└──────────────┬───────────────┘
               │  WSS
               │
┌──────────────▼───────────────────────────────────────────────┐
│                     OpenClaw Gateway                          │
│                                                              │
│  ┌────────────────────────────────────────┐                  │
│  │         Relay Channel Plugin           │                  │
│  │                                        │                  │
│  │  • Connects outbound to relay          │                  │
│  │  • E2E encryption / decryption         │                  │
│  │  • Translates relay protocol to        │                  │
│  │    gateway API calls                   │                  │
│  │  • Sends notifications to clients      │                  │
│  └────────────────┬───────────────────────┘                  │
│                   │  localhost HTTP                           │
│  ┌────────────────▼───────────────────────┐                  │
│  │        Gateway API (unchanged)         │                  │
│  └────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────┘
```

## 3. Component Specifications

### 3.1 Relay Server

**Language**: Go (single static binary, cross-compile for all platforms)

**Dependencies**: Standard library only (net/http, crypto/tls, nhooyr.io/websocket)

**Deployment**:
- Build from source: `cd relay && go build -o openclaw-relay`
- Run: `./openclaw-relay --tls auto --domain relay.example.com`

**Configuration** (CLI flags only, no config file):

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 8443 | Listen port |
| `--tls` | off | TLS mode: `off`, `auto` (ACME/Let's Encrypt), or `manual` |
| `--cert` | — | TLS cert path (when `--tls manual`) |
| `--key` | — | TLS key path (when `--tls manual`) |
| `--max-channels` | 500 | Maximum concurrent channels |
| `--max-clients-per-channel` | 10 | Maximum clients per channel |
| `--rate-limit` | 100 | Messages per second per channel |
| `--max-payload` | 1048576 | Maximum payload size in bytes (1 MB) |
| `--public` | false | Advertise in /status as a public relay |
| `--domain` | — | Domain name (for ACME TLS) |
| `--log-format` | `text` | Log format: `text` or `json` |

**Internal state** (all in-memory, lost on restart):

```go
type Relay struct {
    channels map[string]*Channel  // key: channel_hash
}

type Channel struct {
    gateway *websocket.Conn
    clients map[string]*websocket.Conn  // key: client_id
}
```

**Estimated code size**: 300-500 lines of Go.

### 3.2 OpenClaw Channel Plugin

**Integration**: Follows the same pattern as the Feishu channel plugin — registers as a channel, receives messages from the gateway message bus, sends replies back.

**Responsibilities**:
1. On startup: connect to relay (specified or auto-discovered)
2. Register channel with token hash
3. Handle E2E encryption (Layer 1)
4. Enter pairing mode when the user runs `openclaw relay pair`, approve exactly one new client key, and persist the approved client record
5. Translate incoming relay requests to gateway API calls
6. Send gateway events (cron completions, agent outputs) as notifications to connected clients

**Configuration** (in `openclaw.json`):

```json5
{
  channels: {
    relay: {
      enabled: true,
      // Explicit relay server (optional — auto-discover if omitted)
      server: "wss://my-relay.example.com",
      // Generated on first enable
      channelToken: "kx8f-a3mv-9pqz",
      // Gateway's X25519 private key (generated on first enable)
      privateKey: "base64(...)",
      // Approved client public keys
      clients: {
        "client_uuid_1": {
          publicKey: "base64(...)",
          name: "My Phone",
          addedAt: "2026-03-07T10:00:00Z"
        }
      }
    }
  }
}
```

**CLI commands**:

```bash
# Enable relay channel (generates keys, discovers relay)
openclaw relay enable [--server wss://...]

# Show pairing code / QR for a new client
openclaw relay pair

# List connected clients
openclaw relay clients

# Revoke a client
openclaw relay revoke <client_id>

# Disable relay
openclaw relay disable
```

### 3.3 Reference Client

**Technology**: Single-page web application (vanilla JS or lightweight framework)

**Deployment**:
- Hosted as static files (GitHub Pages, any CDN, or local `file://`)

**Core features** (reference implementation):
- Connect to relay or direct to gateway
- Pairing (scan QR or enter code)
- Send messages to agents, receive streaming responses
- Markdown rendering for agent output
- Notification inbox for async results (cron, background tasks)
- Basic session history browsing

**What it deliberately does NOT include** (left to users):
- Agent configuration UI
- File management
- Cron editor
- System monitoring dashboard
- Custom themes / branding

### 3.4 SDK

**Python SDK** (`sdk/python/`) — implemented, layers 0–2:

```python
from openclaw_relay import RelayClient

client = RelayClient(
    relay="wss://relay.example.com",
    token="kx8f-a3mv-9pqz",
    gateway_public_key="...",
)

async with client.connect() as conn:
    # Chat with streaming
    async for chunk in conn.chat("tangseng", "What is the news today?"):
        print(chunk.delta, end="")

    # List agents
    agents = await conn.agents.list()
```

## 4. Public Relay Discovery

### Registry Format

The file `relays.json` in the project repository:

```json
[
  {
    "url": "wss://relay.alice.dev",
    "region": "cn-east",
    "operator": "alice",
    "operator_url": "https://github.com/alice",
    "capacity": 500,
    "since": "2026-03-01",
    "notes": "Hosted on Aliyun Shanghai"
  }
]
```

### Discovery Flow

```
1. Plugin loads the last-known-good relay list from local cache (if present)
2. Plugin reads the primary registry URL plus any configured mirrors
3. Fetches and parses the first reachable registry
4. If all registry fetches fail, continue with the cached list and surface a warning
5. For each relay: GET /status (with 5s timeout)
6. Filters: only relays with status.public == true and available capacity
7. Sorts by: latency (primary), available capacity (secondary)
8. Selects the best relay
9. User can override with --server flag
```

The OpenClaw plugin SHOULD cache the last-known-good relay list locally. If the registry URL is unreachable, the plugin falls back to the cached list. This prevents a single point of failure in relay discovery.

### Adding a Public Relay

1. Deploy a relay with `--public` flag
2. Ensure `/status` endpoint is accessible
3. Fork the repo, add entry to `relays.json`
4. Submit a PR
5. CI validates the relay is reachable and healthy
6. Community reviews and merges

### Relay Health Monitoring

A GitHub Action runs daily:
- Probes all relays in `relays.json`
- Opens an issue if a relay is unreachable for 3+ consecutive days
- Maintainers can remove dead relays

### Discovery Resilience

- The registry format should remain static and cacheable so clients can safely keep a last-known-good copy.
- Public deployments should publish at least one mirror URL outside a single hosting provider.
- A future hardening step should add a signed registry manifest so clients can detect tampering independently of transport availability.

## 5. Security Analysis

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Relay reads messages | E2E encryption; relay only sees ciphertext |
| Relay modifies messages | AES-GCM authentication; tampering detected |
| Relay replays messages | Monotonic nonce counters; replay detected |
| Man-in-the-middle during pairing | Pairing info transferred out-of-band (QR/manual); browser verifies a user-supplied pinned gateway public key during handshake |
| Unauthorized client connects | Channel token is secret; unknown client keys are accepted only during explicit pairing mode |
| Unauthorized client sends messages | E2E encryption; can't decrypt without shared secret |
| Nonce reuse after reconnect | Derive a fresh session key for every connection using both peers' session nonces |
| Relay denial of service | Switch to another relay; token and keys are portable |
| Compromised gateway keys | Revoke and re-pair; rotate keys |

### What the Relay Can See

- That a connection exists on a given channel hash
- When gateway and clients are online/offline
- Volume and timing of messages (traffic analysis)
- Encrypted payload sizes

### What the Relay Cannot See

- Channel token (only the hash)
- Message content
- Who the user is (no authentication required to run a relay)
- Which agent is being used
- What is being discussed

## 6. LAN Direct Connection

When the client and OpenClaw are on the same network, the relay is unnecessary.

### Discovery

The OpenClaw gateway plugin advertises via mDNS:

```
Service: _openclaw._tcp.local.
Port: 18789
TXT: version=2026.3.2, relay=enabled
```

The client app:
1. On startup, queries mDNS for `_openclaw._tcp.local.`
2. If found, connects directly to the gateway over the local transport exposed by the gateway
3. Uses the same Layer 1 encryption (keys from pairing)
4. If mDNS fails, falls back to relay connection

### Seamless Switching

The Connection Manager in the client maintains both paths:
- Direct (LAN): lower latency, no relay dependency
- Relay (WAN): works from anywhere

When the user moves between networks, the client automatically switches. The application layer (Layer 3) is identical in both cases — only the transport changes.

## 7. Current Status

Phase 1 (Foundation / Secure MVP) is complete and shipped as v0.5.0:

- Protocol specification (v1, frozen)
- Go relay server with channel matching, forwarding, /status, abuse controls, structured logging
- E2E encryption (Layer 1: X25519 + HKDF + AES-256-GCM)
- Python SDK (layers 0–2)
- OpenClaw relay channel plugin (secure pairing, chat, agent-to-agent peer discovery)
- Browser reference client (connect, pair, chat, streaming)

Not yet implemented: JavaScript SDK, mDNS LAN discovery, Tauri/mobile wrappers.
