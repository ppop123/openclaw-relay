# OpenClaw Relay

[中文](#中文) | [English](#english)

---

## 中文

OpenClaw Relay 是一个面向 OpenClaw 的开源、去中心化远程连接方案。

你可以从任何地方连接自己的 OpenClaw 实例——不需要公网 IP，不依赖第三方聊天平台，默认端到端加密。

> **AI-first 项目。** 这个仓库中的代码由 [Claude Code](https://claude.ai/code) 生成，并由 [Codex](https://openai.com/codex) 复审。整个项目按“让 AI 也能稳定读取和实现”的目标来组织：包含 machine-readable truth sources、结构化协议 fixture，以及优先强调精确性的技术文档。参见 [`docs/ai-implementation-guide.md`](docs/ai-implementation-guide.md)。

### 要解决的问题

OpenClaw 通常运行在一台位于 NAT 后面的本地机器上。当前很多用户仍然依赖飞书、Telegram、Discord 之类的第三方平台远程和自己的代理交互。这会带来平台依赖，也会把远程交互能力限制在“文本消息”这一层。

### 方案概览

OpenClaw Relay 在客户端和你的 OpenClaw Gateway 之间建立一条简单、安全的连接通道：

```
[客户端] ──WSS──> [Relay] <──WSS── [OpenClaw Gateway]
 (任意位置)      (公网节点)         (你的本地机器)
```

两端都是**主动向外连接**：
- 不需要端口映射
- 不需要公网 IP
- 不需要自己配置 DNS

所有业务消息都做**端到端加密**，Relay 只能看到不可读的密文。

### 核心原则

- **无厂商锁定**：Relay 可轻量自托管（单二进制、无数据库）
- **没有官方中心服务**：社区可以运行公共 Relay，本仓库维护可公开发现的节点列表
- **端到端加密**：Relay 运营者无法读取消息内容
- **开放协议**：任何人都可以实现自己的客户端、SDK 或 Relay
- **可扩展**：仓库内的参考客户端只是起点，不是唯一形态


### 核心价值观

- **Agent First**
  - 产品首先是为 agent 服务的，不是为人类社交服务的。
  - 人类界面存在的意义，是让人类能授权、监督、接受这套系统。
- **人的主权不能丢**
  - 人类可以随时和自己的 OpenClaw 交互。
  - 但人类不能借这个系统去发现、联系别人的 OpenClaw。
- **AI 可以协作，人类不能越权**
  - agent 可以找 agent、连 agent、和 agent 协作。
  - 但这是一种受控、可配置、operator 明确同意后的能力。
- **Relay 只是交换台，不是平台**
  - 我们不做中心化社交平台，不做官方总控中心。
  - relay 只负责转发和可达性，不负责理解内容、不负责控制关系。

### 最新发布

`OpenClaw Relay v0.5.0` 已发布。

正式支持范围：

- `relay/` — Go Relay 服务端
- `sdk/python/` — Python 客户端 SDK（Layers 0–2）
- `client/` — Web 参考客户端
- `protocol/` — 协议文档与 canonical fixtures
- `plugin/` — OpenClaw Gateway 插件

当前不在正式发布范围内：

- `sdk/js/` — 尚未实现

发布说明：

- 中文：[`docs/releases/v0.5.0-github-release.zh-CN.md`](docs/releases/v0.5.0-github-release.zh-CN.md)
- English: [`docs/releases/v0.5.0-github-release.en.md`](docs/releases/v0.5.0-github-release.en.md)

### 项目状态

当前版本中，核心 Relay 栈（Go 服务端、Python SDK、Web 客户端）、OpenClaw Gateway 插件，以及协议规范都已经**实现并测试**。配套的架构设计和运维文档也已经补齐。

v1 目标是**单 Relay 节点部署**。集群、联邦、多活和高可用明确不在 v1 范围内。

### 如何使用

把它想简单一点：

- `relay/` 是一台公开可访问的中转站
- `plugin/` 是装在你自己 OpenClaw 里的“回家通道”
- `client/` 是你在浏览器里远程使用自己 OpenClaw 的界面

#### 最常见的用法：远程使用你自己的 OpenClaw

大多数人只需要 3 步：

1. **部署一个 Relay**：按 [`docs/quick-start.md`](docs/quick-start.md) 或 [`docs/deployment.md`](docs/deployment.md) 跑起 `relay/`
2. **把 Relay 插件装进你自己的 OpenClaw**：执行 `openclaw plugins install --link /path/to/openclaw-relay/plugin`，然后运行 `openclaw relay enable --server <relay>`
3. **一边配对，一边从浏览器连接**：先运行 `openclaw relay pair --wait 30`。它会立刻打印 pairing 信息并保持 30 秒配对窗口；在这 30 秒内打开 `client/` 里的 Web client，把刚打印出来的 relay 地址、channel token 和 gateway 公钥填进去并点击连接

你得到的是：

- 可以从外面连回自己的 OpenClaw
- 不需要公网 IP
- 不需要端口映射
- Relay 只负责转发，看不懂消息内容

#### 高级用法：让两台 OpenClaw 的 agent 互相协作

这个能力现在也已经可用，但它是 **agent-only**，默认不打开：

- 只有 gateway / agent 可以发现并联系别家的 agent
- **人类客户端不能拿它去找别人的 OpenClaw**
- 这是操作员显式 opt-in 的高级能力，入口见 [`plugin/README.md`](plugin/README.md)

如果你不是直接用浏览器，而是要自己写客户端：

- **Python 客户端**：从 `sdk/python/` 开始
- **自定义客户端 / 审计实现**：从 `protocol/` 和 [`docs/ai-implementation-guide.md`](docs/ai-implementation-guide.md) 开始

推荐阅读顺序：[`docs/quick-start.md`](docs/quick-start.md) → [`docs/deployment.md`](docs/deployment.md) → [`docs/web-client.md`](docs/web-client.md) → [`plugin/README.md`](plugin/README.md)。

### 组件一览

| 组件 | 说明 | 状态 |
|------|------|------|
| [协议规范](protocol/) | 线协议与分层说明 | v1 |
| `relay/` | Go 版参考 Relay 实现 | 已实现，已测试 |
| `sdk/python/` | Python 客户端 SDK（协议层 0–2） | 已实现，已测试 |
| `client/` | 浏览器 Web 客户端 | 已实现，已测试 |
| `sdk/js/` | JavaScript 协议库 | 尚未实现 |
| `plugin/` | OpenClaw Gateway 插件 | 已实现，已测试 |

### 文档入口

- [`docs/README.md`](docs/README.md) — 文档中心 / 技术导航
- [`docs/architecture-overview.md`](docs/architecture-overview.md) — 当前架构总览
- [`docs/web-client.md`](docs/web-client.md) — 浏览器客户端文档入口
- [`docs/web-client/architecture.md`](docs/web-client/architecture.md) — 浏览器运行时结构与模块地图
- [`docs/web-client/identity-and-storage.md`](docs/web-client/identity-and-storage.md) — 浏览器身份生命周期与存储规则
- [`docs/web-client/transport.md`](docs/web-client/transport.md) — 浏览器握手、加密、请求响应与重连行为
- [`docs/web-client/ui-and-state.md`](docs/web-client/ui-and-state.md) — 浏览器 UI 状态与用户流程
- [`docs/web-client/testing-and-troubleshooting.md`](docs/web-client/testing-and-troubleshooting.md) — 浏览器测试、人工检查与排障
- [`docs/deployment.md`](docs/deployment.md) — 部署与运维
- [`docs/security.md`](docs/security.md) — 安全属性与限制
- [`docs/support-matrix.md`](docs/support-matrix.md) — 支持矩阵与发布范围

### 快速开始

#### 部署一个 Relay 服务端

```bash
cd relay && go build -o openclaw-relay
./openclaw-relay
# 默认监听 :8443
```

生产环境中的 TLS、Origin 校验、部署方式，请参见 [部署文档](docs/deployment.md)。

#### 运行测试

```bash
cd relay && go test -v -count=1
cd sdk/python && pip install -e ".[dev]" && pytest -q
cd client && npm ci && npm test
cd plugin && npm ci && npm test
cd plugin && npm run typecheck
bash scripts/smoke-openclaw-plugin.sh
```

> **Gateway 插件接入：** 把 `plugin/` 安装到你自己的 OpenClaw 运行时：先执行 `openclaw plugins install --link /path/to/openclaw-relay/plugin` 和 `openclaw relay enable --server <relay>`，再运行 `openclaw relay pair --wait 30` 并在等待窗口里从浏览器完成连接。见 [`docs/quick-start.md`](docs/quick-start.md)。

#### 贡献一个公共 Relay 节点

使用 `--public` 运行 Relay，确保 `GET /status` 可访问，然后提交 PR 把你的节点加到 [`relays.json`](relays.json)。

### 架构图

```
                   端到端加密（Relay 无法读内容）
              ╔══════════════════════════════════════╗
              ║  应用层协议（JSON-RPC / Streaming）  ║
              ║  安全层（X25519 + AES-GCM）         ║
              ╚══════════════════════════════════════╝
                          │            │
 [客户端] ──WSS──> [Relay Server] <──WSS── [OpenClaw Gateway]
                          │
                    Relay 只能看到：
                    • channel token hash
                    • encrypted payload
                    • online/offline status
```

### 公共 Relay 节点

当前社区维护的公共 Relay 列表见 [`relays.json`](relays.json)。

如果你想新增节点，请先确保它通过健康检查（`GET /status`），再提交 PR。

### 许可证

MIT

---

## English

OpenClaw Relay is an open-source, decentralized remote connection solution for OpenClaw.

Connect to your OpenClaw instance from anywhere — no public IP required, no third-party chat platform dependency, end-to-end encrypted by default.

> **AI-first project.** The code in this repository was generated by [Claude Code](https://claude.ai/code) and reviewed by [Codex](https://openai.com/codex). The repository is intentionally structured so AI agents can consume it reliably, with machine-readable truth sources, structured protocol fixtures, and docs that prioritize precision over prose. See [`docs/ai-implementation-guide.md`](docs/ai-implementation-guide.md).

### The Problem

OpenClaw usually runs on a local machine behind NAT. Many users currently rely on third-party platforms such as Feishu, Telegram, or Discord to reach their agents remotely. That creates platform dependency and limits remote interaction to basic text messaging.

### The Solution

OpenClaw Relay creates a simple, secure path between any client and your OpenClaw gateway:

```
[Client] ──WSS──> [Relay] <──WSS── [OpenClaw Gateway]
(anywhere)       (public)          (your local machine)
```

Both sides connect **outbound**:
- no port forwarding
- no public IP requirement
- no custom DNS setup

All application traffic is **end-to-end encrypted**, so the relay only sees opaque bytes.

### Key Principles

- **No vendor lock-in**: the relay is trivial to self-host (single binary, no database)
- **No official central service**: community members can run public relays, and this repo maintains a discoverable list
- **End-to-end encrypted**: relay operators cannot read user messages
- **Open protocol**: anyone can implement alternative clients, SDKs, or relays
- **Extensible**: the reference client is a starting point, not the only intended form factor


### Core Values

- **Agent First**
  - The product exists for agents first, not for human social networking.
  - The human interface exists so people can authorize, supervise, and accept the system.
- **Human sovereignty must not be lost**
  - Humans may always interact with their own OpenClaw.
  - Humans must not use this system to discover or contact other people's OpenClaw instances.
- **Agents may collaborate, humans may not overreach**
  - Agents may discover, connect to, and collaborate with other agents.
  - But this must stay controlled, configurable, and explicitly approved by the operator.
- **The relay is a switchboard, not a platform**
  - We are not building a centralized social platform or an official control center.
  - The relay is responsible only for forwarding and reachability, not for understanding content or controlling relationships.

### Latest Release

`OpenClaw Relay v0.5.0` is available now.

Official release scope:

- `relay/` — Go relay server
- `sdk/python/` — Python client SDK (Layers 0–2)
- `client/` — Web reference client
- `protocol/` — Protocol docs and canonical fixtures
- `plugin/` — OpenClaw gateway plugin

Excluded from the official release scope:

- `sdk/js/` — Not yet implemented

Release notes:

- 中文：[`docs/releases/v0.5.0-github-release.zh-CN.md`](docs/releases/v0.5.0-github-release.zh-CN.md)
- English: [`docs/releases/v0.5.0-github-release.en.md`](docs/releases/v0.5.0-github-release.en.md)

### Project Status

The core relay stack (Go server, Python SDK, web client), the OpenClaw gateway plugin, and the protocol specification are all **implemented and tested**. Architecture and operational documentation are included as well.

v1 targets a **single relay node** deployment. Clustering, federation, multi-node HA, and similar features are explicitly out of scope.

### How To Use It

The simple mental model is:

- `relay/` is the public relay node
- `plugin/` is the bridge installed inside your own OpenClaw
- `client/` is the browser UI you use to talk to your own OpenClaw remotely

#### Most common use: reach your own OpenClaw from anywhere

Most people only need 3 steps:

1. **Deploy a relay**: bring up `relay/` with [`docs/quick-start.md`](docs/quick-start.md) or [`docs/deployment.md`](docs/deployment.md)
2. **Install the relay plugin in your own OpenClaw**: run `openclaw plugins install --link /path/to/openclaw-relay/plugin`, then `openclaw relay enable --server <relay>`
3. **Pair while the browser is open**: run `openclaw relay pair --wait 30` first. It prints the pairing details immediately and keeps the pairing window open for 30 seconds; during that window, open the `client/` web client, paste the printed relay URL, channel token, and gateway public key, then connect

What you get:

- remote access to your own OpenClaw
- no public IP requirement
- no port forwarding
- the relay forwards traffic but cannot read message content

#### Advanced use: let two OpenClaw agents cooperate

This now works too, but it is **agent-only** and stays opt-in:

- only gateways / agents may discover and contact other agents
- **human-facing clients must not browse or contact other OpenClaw instances**
- this is an operator-enabled advanced feature; see [`plugin/README.md`](plugin/README.md)

If you are not using the browser reference client and want to build your own client:

- **Python client**: start with `sdk/python/`
- **Custom client / audited implementation**: start with `protocol/` and [`docs/ai-implementation-guide.md`](docs/ai-implementation-guide.md)

Recommended reading order: [`docs/quick-start.md`](docs/quick-start.md) → [`docs/deployment.md`](docs/deployment.md) → [`docs/web-client.md`](docs/web-client.md) → [`plugin/README.md`](plugin/README.md).

### Components

| Component | Description | Status |
|-----------|-------------|--------|
| [Protocol Spec](protocol/) | Wire protocol and layered behavior | v1 |
| `relay/` | Reference relay implementation in Go | Implemented, tested |
| `sdk/python/` | Python client SDK (protocol layers 0–2) | Implemented, tested |
| `client/` | Browser-based web client | Implemented, tested |
| `sdk/js/` | JavaScript protocol library | Not yet implemented |
| `plugin/` | OpenClaw gateway plugin | Implemented, tested |

### Documentation

- [`docs/README.md`](docs/README.md) — documentation center / technical navigation
- [`docs/architecture-overview.md`](docs/architecture-overview.md) — current architecture summary
- [`docs/web-client.md`](docs/web-client.md) — browser client documentation hub
- [`docs/web-client/architecture.md`](docs/web-client/architecture.md) — browser runtime structure and module map
- [`docs/web-client/identity-and-storage.md`](docs/web-client/identity-and-storage.md) — browser identity lifecycle and storage rules
- [`docs/web-client/transport.md`](docs/web-client/transport.md) — browser handshake, encryption, request/response, and reconnect behavior
- [`docs/web-client/ui-and-state.md`](docs/web-client/ui-and-state.md) — browser UI state and user flows
- [`docs/web-client/testing-and-troubleshooting.md`](docs/web-client/testing-and-troubleshooting.md) — browser tests, manual checks, and troubleshooting
- [`docs/deployment.md`](docs/deployment.md) — deployment and operations
- [`docs/security.md`](docs/security.md) — security properties and limitations
- [`docs/support-matrix.md`](docs/support-matrix.md) — supported components and release scope

### Quick Start

#### Deploy a relay server

```bash
cd relay && go build -o openclaw-relay
./openclaw-relay
# Listens on :8443 by default
```

See the [Deployment Guide](docs/deployment.md) for TLS, origin validation, and production setup.

#### Run tests

```bash
cd relay && go test -v -count=1
cd sdk/python && pip install -e ".[dev]" && pytest -q
cd client && npm ci && npm test
cd plugin && npm ci && npm test
cd plugin && npm run typecheck
bash scripts/smoke-openclaw-plugin.sh
```

> **Gateway plugin setup:** Install `plugin/` into your own OpenClaw runtime with `openclaw plugins install --link /path/to/openclaw-relay/plugin`, then run `openclaw relay enable --server <relay>`. After that, run `openclaw relay pair --wait 30` and complete the browser connection while that pairing window is open. See [`docs/quick-start.md`](docs/quick-start.md).

#### Contribute a public relay

Run a relay with `--public`, make sure `GET /status` is reachable, and submit a PR to add it to [`relays.json`](relays.json).

### Architecture

```
                   E2E encrypted (relay cannot read)
              ╔══════════════════════════════════════╗
              ║  App Protocol (JSON-RPC / Streaming) ║
              ║  Security Layer (X25519 + AES-GCM)   ║
              ╚══════════════════════════════════════╝
                          │            │
 [Client] ──WSS──> [Relay Server] <──WSS── [OpenClaw Gateway]
                          │
                    Relay only sees:
                    • channel token hash
                    • encrypted payload
                    • online/offline status
```

### Public Relay Nodes

See [`relays.json`](relays.json) for the current list of community-operated public relays.

To add your own relay, make sure it passes the health check (`GET /status`) and then open a PR.

### License

MIT
