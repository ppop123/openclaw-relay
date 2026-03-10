# Documentation Center

[中文](#中文) | [English](#english)

---

## 中文

这里是 OpenClaw Relay 的技术文档中心。

如果你刚接触这个项目，建议从这里开始，不要直接跳进具体的设计文档。

当前官方一方用户端聚焦桌面：桌面浏览器继续支持，Windows/macOS 的共享桌面壳位于 `desktop/`。手机和平板不属于官方支持面。

### 从这里开始

| 文档 | 用途 |
|------|------|
| `README.md` | 项目首页、版本范围、快速入口 |
| `docs/quick-start.md` | Relay、客户端、插件的快速搭建 |
| `docs/architecture-overview.md` | 面向实现的架构总览 |
| `docs/deployment.md` | Relay 部署、CLI 参数、运维、排障 |
| `docs/security.md` | 安全属性、限制、存储规则 |
| `docs/support-matrix.md` | 已支持与未实现的组件 |
| `docs/ai-implementation-guide.md` | AI 优先的事实、不变量（Invariants）、发布门禁 |

### 规范机器可读源

当 Markdown 文档与机器可读文件冲突时，以机器可读文件为准。

| 事实 | 来源 |
|------|------|
| 组件支持范围 | `docs/support-matrix.json` |
| 版本范围与发布门禁 | `docs/release-manifest.json` |
| 协议错误码 | `protocol/error-codes.json` |
| 协议示例 | `protocol/examples/*.json` |
| 浏览器客户端组件清单 | `docs/web-client/manifest.json` |
| 浏览器客户端存储契约 | `docs/web-client/storage-schema.json` |
| 浏览器客户端状态模型 | `docs/web-client/state-machine.json` |

### 协议文档

| 文档 | 范围 |
|------|------|
| `protocol/layer0-channel.md` | Relay 频道帧（Channel Frames）与在线状态 |
| `protocol/layer1-security.md` | 身份、密钥交换（Key Exchange）、会话密钥 |
| `protocol/layer2-transport.md` | 请求/响应/流式传输 |
| `protocol/layer3-application.md` | 应用方法与载荷契约 |

### 组件文档

| 文档 | 范围 |
|------|------|
| `docs/web-client.md` | 浏览器客户端文档入口 |
| `docs/web-client/architecture.md` | 浏览器运行时结构与模块边界 |
| `docs/web-client/identity-and-storage.md` | 浏览器身份生命周期与存储规则 |
| `docs/web-client/transport.md` | 浏览器握手、加密、请求/响应、重连行为 |
| `docs/web-client/ui-and-state.md` | 浏览器 UI 结构、应用状态、用户流程 |
| `docs/web-client/testing-and-troubleshooting.md` | 浏览器测试覆盖、手动检查、故障模式 |
| `desktop/README.md` | Windows/macOS 桌面壳、安装与本地构建 |
| `plugin/README.md` | OpenClaw Gateway 插件安装、运行时、冒烟验证 |
| `docs/self-host-relay.md` | 自托管说明 |
| `docs/technical-design.md` | 详细设计背景与系统整体理念 |

### 规划与历史

| 文档 | 范围 |
|------|------|
| `docs/releases/` | 历史版本说明与 README 更新草稿 |
| `docs/plans/` | 设计方案与实现提案 |
| `docs/architecture-audit-review.md` | 架构审查与审计笔记 |

### 阅读顺序

推荐大多数工程师按以下顺序阅读：

在修改任何依赖 OpenClaw 运行时行为的内容之前，先查看本地 OpenClaw 源码。本机上一个已验证的安装根目录是 `/opt/homebrew/lib/node_modules/openclaw/dist`，但在其他机器上必须先确认实际的本地安装路径。不要仅凭文档来了解请求格式、会话存储、对话记录布局或 Gateway/运行时语义。

1. `README.md`
2. `docs/architecture-overview.md`
3. `docs/security.md`
4. `docs/support-matrix.md`
5. `docs/web-client.md` 或 `plugin/README.md`，取决于你要改什么
6. `protocol/` 层协议文档，了解精确的线上行为

---

## English

This directory is the current technical documentation hub for OpenClaw Relay.

If you are new to the project, start here instead of jumping straight into detailed design documents.

Official first-party user clients stay desktop-focused: the browser client remains supported on desktop, and the shared Windows/macOS desktop shell lives in `desktop/`. Phones and tablets are not official support targets.

### Start Here

| Document | Purpose |
|----------|---------|
| `README.md` | Project homepage, release scope, quick entry points |
| `docs/quick-start.md` | Fast setup for relay, client, and plugin |
| `docs/architecture-overview.md` | Current implementation-oriented architecture summary |
| `docs/deployment.md` | Relay deployment, CLI flags, operations, troubleshooting |
| `docs/security.md` | Security properties, limits, and storage rules |
| `docs/support-matrix.md` | Supported vs not-yet-implemented components |
| `docs/ai-implementation-guide.md` | AI-first facts, invariants, release gates |

### Canonical Machine-Readable Sources

When Markdown and machine-readable files disagree, the machine-readable files win.

| Fact | Source |
|------|--------|
| Component support scope | `docs/support-matrix.json` |
| Release scope and release gates | `docs/release-manifest.json` |
| Protocol error codes | `protocol/error-codes.json` |
| Protocol examples | `protocol/examples/*.json` |
| Web client component manifest | `docs/web-client/manifest.json` |
| Web client storage contract | `docs/web-client/storage-schema.json` |
| Web client state model | `docs/web-client/state-machine.json` |

### Protocol Documentation

| Document | Scope |
|----------|-------|
| `protocol/layer0-channel.md` | Relay channel frames and presence |
| `protocol/layer1-security.md` | Identity, key exchange, session keys |
| `protocol/layer2-transport.md` | Request/response/streaming transport |
| `protocol/layer3-application.md` | Application methods and payload contracts |

### Component-Focused Docs

| Document | Scope |
|----------|-------|
| `docs/web-client.md` | Browser client documentation hub |
| `docs/web-client/architecture.md` | Browser runtime structure and module boundaries |
| `docs/web-client/identity-and-storage.md` | Browser identity lifecycle and storage rules |
| `docs/web-client/transport.md` | Browser handshake, encryption, request/response, reconnect behavior |
| `docs/web-client/ui-and-state.md` | Browser UI structure, app state, user flows |
| `docs/web-client/testing-and-troubleshooting.md` | Browser test coverage, manual checks, failure patterns |
| `desktop/README.md` | Windows/macOS desktop shell, install, and local build |
| `plugin/README.md` | OpenClaw gateway plugin install, runtime, smoke validation |
| `docs/self-host-relay.md` | Self-hosting notes |
| `docs/technical-design.md` | Detailed design background and broader system rationale |

### Planning and History

| Document | Scope |
|----------|-------|
| `docs/releases/` | Historical release notes and README update drafts |
| `docs/plans/` | Design plans and implementation proposals |
| `docs/architecture-audit-review.md` | Architecture review and audit notes |

### Reading Order

Recommended order for most engineers:

Before changing anything that depends on OpenClaw runtime behavior, inspect the local OpenClaw source first. On this machine one validated install root is `/opt/homebrew/lib/node_modules/openclaw/dist`, but on other machines you must verify the real local install path before reading the source. Do not rely on prose docs alone for request shapes, session storage, transcript layout, or gateway/runtime semantics.

1. `README.md`
2. `docs/architecture-overview.md`
3. `docs/security.md`
4. `docs/support-matrix.md`
5. `docs/web-client.md` or `plugin/README.md` depending on what you are changing
6. `protocol/` layer docs for exact wire behavior
