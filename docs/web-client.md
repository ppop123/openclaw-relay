[中文](#中文) | [English](#english)

---

## 中文

# 浏览器客户端

本文档是 `client/` 下浏览器端 OpenClaw Relay 客户端的入口文档。

浏览器客户端是随项目发布的**浏览器参考客户端**。它不是独立的 JavaScript SDK，也不提供嵌入式 API。它的作用是在真实浏览器环境中演示和实现 Relay 协议的客户端部分。Windows/macOS 官方桌面壳也直接复用这份前端，所以这里的连接逻辑和 UI 规则同样约束 `desktop/`。

## 这个客户端是什么

当前浏览器客户端负责：

- 建立到 Relay 的 WebSocket 连接
- 在浏览器中完成 Layer 1 握手（Handshake）
- 派生每连接的会话密钥（Session Key）
- 加解密 Layer 2 流量
- 管理请求/响应/流式传输状态
- 渲染一个最小化的聊天界面
- 持久化浏览器安全设置
- 在 IndexedDB 可用时持久化浏览器身份密钥对（Identity Keypair）
- 为共享桌面壳提供同样的连接和状态体验

## 这个客户端不是什么

当前浏览器客户端**不是**：

- 可复用的 JavaScript SDK
- Gateway 实现
- Relay 实现
- 功能完整的生产级聊天应用
- 跨浏览器的身份导出/导入管理器

## 当前状态

浏览器客户端已正式支持，并纳入 CI 覆盖。

目前提供的功能：

- 真实的浏览器端 Layer 0 / 1 / 2 行为
- 通过用户提供的固定公钥实现网关公钥锁定（Gateway Public-Key Pinning）
- 同一浏览器配置下，跨页面刷新保持稳定的加密身份
- 为非敏感连接设置提供命名的已保存 Relay 配置
- 首选的 `Pairing link` 接入路径，以及只在需要时展开的手动连接信息
- 连接界面中的身份指纹（Fingerprint）显示、复制，以及受保护的导出/导入操作
- 流式 `chat.send`
- 通过 `agents.list` 加载 Agent 列表
- 重连和刷新时恢复上次选择的 Agent（如果该 Agent 仍然可用）
- 紧凑的聊天状态栏，以及可展开的连接详情（显示会话、客户端、配置、网关、加密和身份状态）
- 本地 `New chat` 按钮，重置 `sessionId` 但不断开连接
- 将当前内存中的聊天记录显式导出为 JSON
- 安全的 Markdown 渲染（用于助手输出）
- 针对 UI 状态、配对交接（pairing handoff）、身份持久化、加密、传输层和 Markdown 安全性的自动化测试
- 本地真实浏览器 E2E 冒烟流程，覆盖连接、流式聊天、刷新持久化、受保护的身份备份/恢复和记录导出

当前主要限制：

- 不支持本地会话历史持久化
- 如果 IndexedDB 不可用或被阻止，身份回退为仅页面内存

## 文档索引

| 文档 | 范围 |
|------|------|
| `docs/web-client/architecture.md` | 运行时结构、模块边界、状态模型 |
| `docs/web-client/identity-and-storage.md` | `clientId`、密钥对生命周期、浏览器存储规则 |
| `docs/web-client/transport.md` | 握手、加密、请求/响应、重连行为 |
| `docs/web-client/ui-and-state.md` | DOM 结构、应用状态、用户流程、渲染行为 |
| `docs/web-client/testing-and-troubleshooting.md` | 测试覆盖、手动检查、常见故障模式 |
| `docs/web-client/manifest.json` | 机器可读的浏览器客户端组件清单 |
| `docs/web-client/storage-schema.json` | 机器可读的浏览器存储契约 |
| `docs/web-client/state-machine.json` | 机器可读的连接、请求、UI 和身份状态模型 |

## 速查表

| 主题 | 当前行为 |
|------|---------|
| 运行时模型 | 从 `client/index.html` 加载的纯浏览器模块 |
| 构建步骤 | 无 |
| LocalStorage | `openclaw-relay-settings`（`relayUrl`、`gatewayPubKey`、`selectedProfileId`、`selectedAgent`）、`openclaw-relay-profiles`（已保存的 Relay 配置）、`openclaw-relay-client-id`（`clientId`） |
| IndexedDB | `openclaw-relay-browser` → `identity` store，存储浏览器 X25519 密钥对 |
| 绝不持久化到浏览器存储 | `channelToken`、会话密钥、解密后的消息 |
| 身份密钥对 | 启动时从 IndexedDB 加载（如果可用）；否则在首次连接时创建，并尽可能持久化 |
| 刷新行为 | 同一浏览器配置下，刷新后复用相同身份，除非用户重置或持久化不可用 |
| 身份文件流程 | 导出/导入可移植的 JSON 身份文件，支持可选的密码保护，以及可复制的指纹/公钥辅助功能 |
| 主传输类 | `client/js/transport.js` → `RelayConnection` |
| 主加密类 | `client/js/crypto.js` → `RelayCrypto` |
| 身份存储模块 | `client/js/identity-store.js` |
| 应用入口 | `client/js/app.js` |
| 测试命令 | `cd client && npm ci && npm test`（单元测试）、`cd client && npm run test:e2e`（确定性浏览器 E2E）、`cd client && npm run test:e2e:live`（连接真实 Relay/Gateway 的 E2E） |

## 推荐阅读顺序

修改浏览器客户端的工程师建议按以下顺序阅读：

1. `docs/web-client/architecture.md`
2. `docs/web-client/identity-and-storage.md`
3. `docs/web-client/transport.md`
4. `docs/web-client/ui-and-state.md`
5. `docs/web-client/testing-and-troubleshooting.md`

如需了解具体的线路行为，请参阅：

- `protocol/layer0-channel.md`
- `protocol/layer1-security.md`
- `protocol/layer2-transport.md`
- `protocol/layer3-application.md`

## 真实性原则

本文档描述的是当前实现。当文档与代码冲突时，以代码为准。当协议行为存疑时，以协议文档和机器可读的固定文件为权威来源。

浏览器客户端相关的机器可读权威来源：

- `docs/web-client/manifest.json`
- `docs/web-client/storage-schema.json`
- `docs/web-client/state-machine.json`

如果浏览器客户端的 Markdown 说明与上述 JSON 文件在存储键、模块归属或状态转换方面存在矛盾，在文档修正之前，应以 JSON 文件为准。

---

## English

# Web Client

This document is the entry point for the browser-side OpenClaw Relay client under `client/`.

The web client is the shipped **browser reference client**. It is not a standalone JavaScript SDK and it does not expose a supported embedding API. Its job is to demonstrate and implement the client side of the relay protocol in a real browser environment. The official Windows/macOS desktop shell also reuses this same frontend, so the connection model and UI rules here apply to `desktop/` as well.

## What This Client Is

The current web client is responsible for:

- opening a WebSocket connection to the relay
- performing the Layer 1 handshake in the browser
- deriving the per-connection session key
- encrypting and decrypting Layer 2 traffic
- managing request / response / streaming state
- rendering a minimal chat-oriented UI
- persisting safe browser settings
- persisting the browser identity keypair in IndexedDB when available
- serving as the shared frontend for the official Windows/macOS desktop shell

## What This Client Is Not

The current web client is **not**:

- a reusable JavaScript SDK
- a gateway implementation
- a relay implementation
- a full-featured production chat application
- a cross-browser identity export / import manager

## Current Status

The web client is officially supported and covered by CI.

It currently provides:

- real browser-side Layer 0 / 1 / 2 behavior
- gateway public-key pinning via user-supplied pinned key
- stable browser cryptographic identity across reloads in the same browser profile
- named saved relay profiles for non-secret connection settings
- a primary `Pairing link` onboarding path with manual connection fields kept as an advanced fallback
- identity fingerprint plus copy, protected export / import, and reset actions in the connect UI
- streaming `chat.send`
- agent list loading via `agents.list`
- preferred agent restore across reconnects and reloads when that agent is still available
- a compact chat-panel status bar plus expandable connection details for session, client, profile, gateway, encryption, and identity state
- local `New chat` control that resets `sessionId` without disconnecting
- explicit export of the current in-memory chat transcript as JSON
- secure Markdown rendering for assistant output
- automated tests for UI state, identity persistence, crypto, transport, and Markdown safety
- a local real-browser E2E smoke flow for connect, streaming chat, reload persistence, protected identity backup/restore, and transcript export

Its largest current limitations are:

- no persisted local conversation history
- if IndexedDB is unavailable or blocked, identity falls back to page-memory only

## Document Map

| Document | Scope |
|----------|-------|
| `docs/web-client/architecture.md` | Runtime structure, module boundaries, state model |
| `docs/web-client/identity-and-storage.md` | `clientId`, keypair lifecycle, browser storage rules |
| `docs/web-client/transport.md` | Handshake, encryption, request/response, reconnect behavior |
| `docs/web-client/ui-and-state.md` | DOM structure, app state, user flows, rendering behavior |
| `docs/web-client/testing-and-troubleshooting.md` | Test coverage, manual checks, common failure patterns |
| `docs/web-client/manifest.json` | Machine-readable component manifest for the browser client |
| `docs/web-client/storage-schema.json` | Machine-readable browser storage contract |
| `docs/web-client/state-machine.json` | Machine-readable connection, request, UI, and identity state model |

## Quick Facts

| Topic | Current Behavior |
|-------|------------------|
| Runtime model | Plain browser modules loaded from `client/index.html` |
| Build step | None |
| LocalStorage | `openclaw-relay-settings` (`relayUrl`, `gatewayPubKey`, `selectedProfileId`, `selectedAgent`), `openclaw-relay-profiles` (saved relay profiles), and `openclaw-relay-client-id` (`clientId`) |
| IndexedDB | `openclaw-relay-browser` → `identity` store for the browser X25519 keypair |
| Never persisted to browser storage | `channelToken`, session keys, decrypted messages |
| Identity keypair | Loaded from IndexedDB on startup when available; otherwise created on first connect and then persisted if possible |
| Reload behavior | Reuses the same identity after full reload in the same browser profile unless the user resets it or persistence is unavailable |
| Identity file workflow | Export/import portable JSON identity files, with optional passphrase protection plus copyable fingerprint/public key helpers |
| Main transport class | `client/js/transport.js` → `RelayConnection` |
| Main crypto class | `client/js/crypto.js` → `RelayCrypto` |
| Identity store module | `client/js/identity-store.js` |
| App entry | `client/js/app.js` |
| Test command | `cd client && npm ci && npm test` for unit tests, `cd client && npm run test:e2e` for deterministic browser E2E, `cd client && npm run test:e2e:live` for real relay/gateway E2E |

## Reading Order

Recommended reading order for engineers changing the browser client:

1. `docs/web-client/architecture.md`
2. `docs/web-client/identity-and-storage.md`
3. `docs/web-client/transport.md`
4. `docs/web-client/ui-and-state.md`
5. `docs/web-client/testing-and-troubleshooting.md`

For exact wire behavior, always fall through to:

- `protocol/layer0-channel.md`
- `protocol/layer1-security.md`
- `protocol/layer2-transport.md`
- `protocol/layer3-application.md`

## Source of Truth Rule

This document explains the current implementation. When this document conflicts with code, the code wins. When protocol behavior is in question, the protocol documents and machine-readable fixtures remain authoritative.

For browser-client-specific facts, the machine-readable companion sources are:

- `docs/web-client/manifest.json`
- `docs/web-client/storage-schema.json`
- `docs/web-client/state-machine.json`

If a browser-client Markdown explanation and one of these JSON files disagree about storage keys, module ownership, or state transitions, the JSON file should be treated as authoritative until the prose is corrected.
