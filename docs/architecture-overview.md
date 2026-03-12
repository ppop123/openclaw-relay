# Architecture Overview / 架构总览

[中文](#中文) | [English](#english)

---

## 中文

本文描述 OpenClaw Relay **当前已实现的架构**。

内容比 `docs/technical-design.md` 更简短、更偏实现。

### 范围

官方支持的组件：

- `relay/` — Go Relay 服务端
- `sdk/python/` — Python 客户端 SDK
- `sdk/js/` — JavaScript 客户端 SDK
- `client/` — 浏览器参考客户端
- `plugin/` — OpenClaw Gateway 插件
- `protocol/` — 协议规范与示例

### 系统拓扑

```text
[Web / Python / JS Client]  ── WSS ──>  [Relay]  <── WSS ──  [OpenClaw Gateway Plugin]
        │                               │                         │
        │                               │                         │
        └──── Layer 1/2/3 protocol ─────┴──────── routed to OpenClaw runtime
```

设计原则：

- **Relay** 是盲转发节点，不解析内容
- **Gateway 插件**负责配对（Pairing）、身份审批和运行时分发
- **客户端**负责网关公钥验证和端到端会话建立

### 各组件职责

| 组件 | 主要职责 |
|------|----------|
| `relay/` | 频道注册、客户端加入、在线状态、消息转发、Layer 0.5 发现/信令/邀请别名路由、速率限制、载荷大小限制、来源校验 |
| `sdk/python/` | 客户端侧协议实现（Layer 0–2）、加密、请求/响应处理 |
| `sdk/js/` | Node 端 JavaScript/TypeScript 客户端 SDK（Layer 0–2）、加密、请求/响应处理 |
| `client/` | 浏览器参考客户端、Layer 1/2 传输、UI、设置、消息渲染 |
| `plugin/` | 网关侧 Relay 适配器、配对、已批准客户端持久化、操作员可控的发现功能、内部对等信令/邀请控制面、OpenClaw 运行时映射 |
| `protocol/` | 帧格式（Frame）、安全模型、传输生命周期、应用层载荷的共享契约 |

### 协议层映射

| 层 | 用途 | 主要文档 |
|----|------|----------|
| Layer 0 / 0.5 | 频道路由，以及仅网关可用的发现/信令/邀请帧 | `protocol/layer0-channel.md` |
| Layer 1 | 身份、握手、会话密钥派生 | `protocol/layer1-security.md` |
| Layer 2 | 请求/响应/流式传输 | `protocol/layer2-transport.md` |
| Layer 3 | 应用层方法 | `protocol/layer3-application.md` |

### 主要运行时流程

#### 1. 网关注册

1. Gateway 插件计算 `channel_hash = SHA-256(channelToken)`
2. Gateway 向 Relay 建立 WebSocket 连接
3. Gateway 发送 `register`
4. Relay 将该频道标记为已被一个网关连接占用

#### 2. 客户端连接 + 配对 / 握手

1. 客户端计算相同的 `channel_hash`
2. 客户端向 Relay 建立 WebSocket 连接并发送 `join`
3. Relay 返回 `joined`，同时告知网关是否在线
4. 客户端在未加密的 `data` 帧中发送 Layer 1 `hello`
5. Gateway 判断该客户端是否已批准，或当前是否处于配对模式
6. Gateway 回复 `hello_ack`
7. 双方通过 HKDF 派生出每连接独立的 AES-GCM 会话密钥
8. 后续所有 Layer 2 载荷均加密传输

#### 3. 仅网关可用的对等发现引导

1. 网关可注册为可发现状态，附带发现公钥（Discovery Public Key）和不透明元数据
2. 任何已注册网关可调用 `discover` 列出同一 Relay 上当前可发现的对等方
3. 可发现网关可向另一个可发现网关发送加密的 `signal` 帧
4. 接受方网关可创建一个短期邀请别名（Invite Alias）
5. 发起方通过 `JOIN.channel = invite_hash` 加入，然后走正常的 `HELLO` / `HELLO_ACK` 流程

面向用户的客户端不参与此流程，UI 中也不应暴露。

#### 4. 请求 / 响应

1. 客户端加密一个 Layer 2 `request`
2. Gateway 解密后路由到 OpenClaw 运行时
3. Gateway 发送加密的 `response`，或先发 `stream_*` 再发最终 `response`
4. 客户端处理挂起的请求或流式状态

### 存储边界

| 组件 | 存储内容 | 禁止存储 |
|------|----------|----------|
| `relay/` | 仅内存中的频道/会话状态 | 应用层明文、长期消息历史 |
| `client/` | 安全的 UI 设置、网关公钥、客户端 ID | `channelToken` |
| `plugin/` | Relay 账户配置、网关身份密钥、已批准客户端 | OpenClaw 运行时之外的应用消息历史 |
| `sdk/python/` | 默认不存储；调用方可自行持久化身份密钥 | Relay 侧状态 |
| `sdk/js/` | 默认不存储；调用方可自行持久化身份密钥 | Relay 侧状态 |

### 安全边界摘要

- Relay 无法读取应用层明文
- v1 使用**静态 X25519 身份密钥对**和**每连接新鲜 Nonce**
- v1 **不提供**前向保密（Forward Secrecy）
- 浏览器客户端在 IndexedDB 可用时将身份密钥对持久化存储，不可用时回退到页面内存
- 插件的已批准客户端持久化是网关侧客户端信任的唯一真实来源
- 浏览器客户端当前使用**用户手动填入的网关公钥**，而非自动的 TOFU 接受并存储流程

详见 `docs/security.md`。

### 测试与发布门禁

当前发布门禁覆盖：

- Go Relay 测试
- Python SDK 测试
- JavaScript SDK 测试
- Web 客户端测试
- 桌面壳构建
- 插件测试
- 插件类型检查
- 协议示例验证
- 文档一致性检查

插件还有一个本地手动冒烟测试：

- `bash scripts/smoke-openclaw-plugin.sh`

### 当前实现限制

- 仅支持单 Relay 节点
- 浏览器客户端的身份持久化依赖浏览器对 IndexedDB 的支持
- 面向用户的客户端有意不暴露对等发现和对等联系的 UX
- Relay 和插件已实现仅网关可用的 Layer 0.5 控制面，包括仅主机 Agent 桥接、邀请范围内的对等方接受、外呼邀请拨号，以及本地 `RelayPeerAgentService` 供 Agent 侧编排
- 插件的运行时集成依赖当前 OpenClaw 插件 API
- 托管 CI 不运行真实的 OpenClaw 生命周期冒烟测试

### 推荐阅读

- `docs/security.md`
- `docs/support-matrix.md`
- `docs/web-client.md`
- `docs/web-client/transport.md`
- `docs/web-client/identity-and-storage.md`
- `plugin/README.md`
- `protocol/`

---

## English

This document describes the **current implemented architecture** of OpenClaw Relay.

It is intentionally shorter and more implementation-oriented than `docs/technical-design.md`.

### Scope

Officially supported components:

- `relay/` — Go relay server
- `sdk/python/` — Python client SDK
- `sdk/js/` — JavaScript client SDK
- `client/` — browser reference client
- `plugin/` — OpenClaw gateway plugin
- `protocol/` — protocol specification and examples

### System Topology

```text
[Web / Python / JS Client]  ── WSS ──>  [Relay]  <── WSS ──  [OpenClaw Gateway Plugin]
        │                               │                         │
        │                               │                         │
        └──── Layer 1/2/3 protocol ─────┴──────── routed to OpenClaw runtime
```

Design rule:

- the **relay** is a blind forwarder
- the **gateway plugin** owns pairing, identity approval, and runtime dispatch
- the **client** owns gateway key verification and end-to-end session setup

### Responsibilities by Component

| Component | Primary Responsibilities |
|----------|---------------------------|
| `relay/` | Channel registration, client join, presence, forwarding, Layer 0.5 discovery/signaling/invite alias routing, rate limiting, payload limits, origin validation |
| `sdk/python/` | Client-side protocol implementation (Layers 0–2), encryption, request/response handling |
| `sdk/js/` | Node-focused JavaScript/TypeScript client SDK (Layers 0–2), encryption, request/response handling |
| `client/` | Browser reference client, Layer 1/2 transport, UI, settings, message rendering |
| `plugin/` | Gateway-side relay adapter, pairing, approved-client persistence, operator-controlled discovery opt-in, internal peer signaling/invite control plane, OpenClaw runtime mapping |
| `protocol/` | Shared contract for frames, security model, transport lifecycle, application payloads |

### Protocol Layer Mapping

| Layer | Purpose | Main Sources |
|------|---------|--------------|
| Layer 0 / 0.5 | Channel routing plus gateway-only discovery/signaling/invite frames | `protocol/layer0-channel.md` |
| Layer 1 | Identity, handshake, session key derivation | `protocol/layer1-security.md` |
| Layer 2 | Request/response/streaming transport | `protocol/layer2-transport.md` |
| Layer 3 | Application methods | `protocol/layer3-application.md` |

### Main Runtime Flows

#### 1. Gateway Registration

1. Gateway plugin derives `channel_hash = SHA-256(channelToken)`
2. Gateway opens a WebSocket to the relay
3. Gateway sends `register`
4. Relay marks the channel as occupied by one gateway connection

#### 2. Client Connect + Pairing / Handshake

1. Client derives the same `channel_hash`
2. Client opens a WebSocket to the relay and sends `join`
3. Relay returns `joined` and indicates whether a gateway is online
4. Client sends Layer 1 `hello` inside an unencrypted `data` frame
5. Gateway decides whether the client is already approved or pairing is active
6. Gateway responds with `hello_ack`
7. Both sides derive a per-connection AES-GCM session key via HKDF
8. All later Layer 2 payloads are encrypted

#### 3. Gateway-Only Peer Discovery Bootstrap

1. A gateway may register as discoverable with a discovery public key and opaque metadata
2. Any registered gateway may call `discover` to list currently discoverable peers on the same relay
3. A discoverable gateway may send encrypted `signal` frames to another discoverable gateway
4. The accepting gateway may create a short-lived invite alias
5. The initiating side joins via `JOIN.channel = invite_hash` and then proceeds through the normal `HELLO` / `HELLO_ACK` flow

Human-facing clients do not participate in this flow and must not expose it in UI.

#### 4. Request / Response

1. Client encrypts a Layer 2 `request`
2. Gateway decrypts it and routes it to the OpenClaw runtime
3. Gateway sends encrypted `response`, or `stream_*` + final `response`
4. Client resolves the pending request or streaming state

### Storage Boundaries

| Component | What It Stores | What It Must Not Store |
|----------|-----------------|------------------------|
| `relay/` | In-memory channel/session state only | Application plaintext, long-term message history |
| `client/` | Safe UI settings, gateway public key, client id | `channelToken` |
| `plugin/` | Relay account config, gateway identity keys, approved clients | Application message history outside OpenClaw runtime |
| `sdk/python/` | Nothing by default; caller may persist identity keys | Relay-side state |
| `sdk/js/` | Nothing by default; caller may persist identity keys | Relay-side state |

### Security Boundary Summary

- Relay cannot read application plaintext
- v1 uses **static X25519 identity keypairs** and **fresh per-connection nonces**
- v1 does **not** provide forward secrecy
- Browser client persists its identity keypair in IndexedDB when available, with page-memory fallback when persistence is unavailable
- Plugin approved-client persistence is the source of truth for gateway-side client trust
- The browser client currently uses a **user-supplied pinned gateway public key**, not an automatic TOFU accept-and-store flow

See `docs/security.md` for the full security notes.

### Test and Release Gates

The release gate currently covers:

- Go relay tests
- Python SDK tests
- JavaScript SDK tests
- Web client tests
- Desktop shell build
- Plugin tests
- Plugin type check
- Protocol example validation
- Documentation consistency check

A local/manual lifecycle smoke also exists for the plugin:

- `bash scripts/smoke-openclaw-plugin.sh`

### Current Implementation Limits

- Single relay node only
- Browser client identity persistence currently depends on IndexedDB availability in the browser environment
- Human-facing clients intentionally do not expose peer discovery or peer-contact UX
- Relay and plugin now implement the gateway-only Layer 0.5 control plane, including a host-only agent bridge, invite-scoped peer acceptance, outbound invite dialing, and a local `RelayPeerAgentService` for agent-side orchestration
- Plugin runtime integration depends on the current OpenClaw plugin APIs
- Hosted CI does not run the real OpenClaw lifecycle smoke

### Recommended Next Reads

- `docs/security.md`
- `docs/support-matrix.md`
- `docs/web-client.md`
- `docs/web-client/transport.md`
- `docs/web-client/identity-and-storage.md`
- `plugin/README.md`
- `protocol/`
