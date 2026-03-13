# OpenClaw Relay

[中文](#中文) | [English](#english)

---

## 中文

OpenClaw Relay 是一个面向 OpenClaw 的开源远程连接方案。从任何地方连回自己的 OpenClaw——不需要公网 IP，不依赖第三方平台，端到端加密。

```
                   端到端加密（Relay 无法读取内容）
              ╔══════════════════════════════════════╗
              ║  应用层协议（JSON-RPC / Streaming）  ║
              ║  安全层（X25519 + AES-GCM）         ║
              ╚══════════════════════════════════════╝
                          │            │
 [客户端] ──WSS──> [Relay Server] <──WSS── [OpenClaw Gateway]
  (任意位置)      (公网节点)              (你的本地机器)
```

两端都是主动向外连接，不需要端口映射，不需要公网 IP。Relay 只转发密文，无法读取消息内容。

### 三步上手

1. **部署 Relay**

   ```bash
   cd relay && go build -o openclaw-relay && ./openclaw-relay
   ```

   生产环境配置见 [`docs/deployment.md`](docs/deployment.md)。

2. **安装 Gateway 插件**

   ```bash
   openclaw plugins install --link /path/to/openclaw-relay/plugin
   openclaw relay enable --server wss://your-relay.example.com/ws
   ```

3. **配对并连接**

   首选方式：在飞书 / Telegram 等聊天里给 OpenClaw 发送 `/relay_pair`，会直接返回一键配对链接。点击后浏览器会自动填入配对参数，并立即清掉地址栏中的敏感 fragment。

   如果没有聊天入口或必须走命令行：

   ```bash
   openclaw relay pair
   ```

   默认情况下，`openclaw relay pair` 会立刻打印配对信息，并把配对窗口保持 5 分钟。把终端里打印的 pairing link（`pairing.uri`）粘贴到客户端的 `Pairing link` 输入框即可。

   如果浏览器客户端有固定地址，也可以用命令行直接生成一键连接链接：

   ```bash
   openclaw relay pair --print-web-url --auto
   ```

   浏览器打开这个链接后会自动填入配对参数，并立即清掉地址栏中的敏感 fragment。

   如果你不用一键链接，也可以把 `pairing.uri` 直接粘贴到客户端首页的 `Pairing link` 输入框。只有在需要时，才展开 `Manual setup` 手动输入底层参数。

完整流程见 [`docs/quick-start.md`](docs/quick-start.md)。

### Agent 间协作

Agent 可以通过 Relay 发现并连接其他 Agent，进行跨实例协作。这个能力默认关闭，需要操作员显式开启。

浏览器客户端不能使用这个能力——它只用来连接你自己的 OpenClaw。

详见 [`plugin/README.md`](plugin/README.md)。

### 组件

| 组件 | 说明 | 状态 |
|------|------|------|
| [`protocol/`](protocol/) | 协议规范 | v1 |
| `relay/` | Go Relay 服务端 | 已发布 |
| `sdk/python/` | Python SDK（协议层 0–2） | 已发布 |
| `client/` | 浏览器客户端 | 已发布 |
| `desktop/` | Windows/macOS 桌面壳（共享浏览器前端） | 已发布 |
| `plugin/` | OpenClaw Gateway 插件 | 已发布 |
| `sdk/js/` | JavaScript SDK | 已发布 |

最新版本：[v1.0.0](https://github.com/ppop123/openclaw-relay/releases/tag/v1.0.0)

桌面壳位于 `desktop/`，面向 Windows 和 macOS，复用同一套 Web client 前端。安装包在 GitHub Releases 中随主 release 一起发布。

### 文档

| 文档 | 说明 |
|------|------|
| [`docs/quick-start.md`](docs/quick-start.md) | 快速上手 |
| [`docs/deployment.md`](docs/deployment.md) | 部署与运维 |
| [`docs/security.md`](docs/security.md) | 安全模型与限制 |
| [`docs/architecture-overview.md`](docs/architecture-overview.md) | 架构总览 |
| [`docs/web-client.md`](docs/web-client.md) | 浏览器客户端 |
| [`desktop/README.md`](desktop/README.md) | Windows/macOS 桌面壳 |
| [`docs/support-matrix.md`](docs/support-matrix.md) | 支持范围 |

### 公共 Relay 节点

社区维护的公共节点列表见 [`relays.json`](relays.json)。

贡献节点：用 `--public` 启动 Relay，确保 `GET /status` 可访问，提交 PR。

### 设计理念

- **为 Agent 而建** — Relay 首先服务于 agent 间的连接和协作，人类界面用于授权和监督
- **自托管优先** — 单二进制、无数据库，任何人都可以运行自己的 Relay
- **Relay 是交换台，不是平台** — 只负责转发和可达性，不理解内容，不控制关系
- **开放协议** — 任何人都可以实现自己的客户端、SDK 或 Relay

> 这个仓库的代码由 [Claude Code](https://claude.ai/code) 生成，[Codex](https://openai.com/codex) 复审。项目结构面向 AI 可读性优化，详见 [`docs/ai-implementation-guide.md`](docs/ai-implementation-guide.md)。

### 许可证

MIT

---

## English

OpenClaw Relay is an open-source remote connection solution for OpenClaw. Reach your own OpenClaw from anywhere — no public IP, no third-party platform, end-to-end encrypted.

```
                   E2E encrypted (relay cannot read)
              ╔══════════════════════════════════════╗
              ║  App Protocol (JSON-RPC / Streaming) ║
              ║  Security Layer (X25519 + AES-GCM)   ║
              ╚══════════════════════════════════════╝
                          │            │
 [Client] ──WSS──> [Relay Server] <──WSS── [OpenClaw Gateway]
  (anywhere)       (public node)          (your local machine)
```

Both sides connect outbound — no port forwarding, no public IP. The relay forwards ciphertext only and cannot read message content.

### Get Started

1. **Deploy a Relay**

   ```bash
   cd relay && go build -o openclaw-relay && ./openclaw-relay
   ```

   Production setup: [`docs/deployment.md`](docs/deployment.md).

2. **Install the Gateway Plugin**

   ```bash
   openclaw plugins install --link /path/to/openclaw-relay/plugin
   openclaw relay enable --server wss://your-relay.example.com/ws
   ```

3. **Pair and Connect**

   Preferred: send `/relay_pair` to OpenClaw via Feishu / Telegram (or your connected chat). It returns a one-click pairing link. Opening it auto-fills the pairing values and immediately clears the sensitive fragment from the browser address bar.

   If you do not have chat access or you must use the CLI:

   ```bash
   openclaw relay pair
   ```

   By default, `openclaw relay pair` prints the pairing details immediately and keeps the pairing window open for 5 minutes. Copy the printed pairing link (`pairing.uri`) into the client's `Pairing link` field.

   If your browser client lives at a known URL, you can also generate a one-click handoff link via CLI:

   ```bash
   openclaw relay pair --print-web-url --auto
   ```

   Opening that link auto-fills the pairing values and then clears the sensitive fragment from the browser address bar.

   If you are not using a one-click browser URL, you can paste `pairing.uri` directly into the client's `Pairing link` field. Expand `Manual setup` only when you need to enter the raw connection values yourself.

Full walkthrough: [`docs/quick-start.md`](docs/quick-start.md).

### Agent-to-Agent Collaboration

Agents can discover and connect to other agents through the relay for cross-instance collaboration. This capability is off by default and requires explicit operator opt-in.

Browser clients cannot use this — they only connect to the owner's own OpenClaw.

Details: [`plugin/README.md`](plugin/README.md).

### Components

| Component | Description | Status |
|-----------|-------------|--------|
| [`protocol/`](protocol/) | Protocol specification | v1 |
| `relay/` | Go relay server | Released |
| `sdk/python/` | Python SDK (layers 0–2) | Released |
| `client/` | Browser client | Released |
| `desktop/` | Windows/macOS desktop shell (shared frontend) | Released |
| `plugin/` | OpenClaw gateway plugin | Released |
| `sdk/js/` | JavaScript SDK | Released |

Latest release: [v1.0.0](https://github.com/ppop123/openclaw-relay/releases/tag/v1.0.0)

The desktop shell lives in `desktop/` for Windows and macOS and reuses the same shared web client frontend. Installers ship on the GitHub Releases page alongside each main release tag.

### Documentation

| Doc | Description |
|-----|-------------|
| [`docs/quick-start.md`](docs/quick-start.md) | Quick start |
| [`docs/deployment.md`](docs/deployment.md) | Deployment and operations |
| [`docs/security.md`](docs/security.md) | Security model and limitations |
| [`docs/architecture-overview.md`](docs/architecture-overview.md) | Architecture overview |
| [`docs/web-client.md`](docs/web-client.md) | Browser client |
| [`desktop/README.md`](desktop/README.md) | Windows/macOS desktop shell |
| [`docs/support-matrix.md`](docs/support-matrix.md) | Support scope |

### Public Relay Nodes

Community-maintained nodes: [`relays.json`](relays.json).

To contribute: run with `--public`, ensure `GET /status` is reachable, submit a PR.

### Design Principles

- **Built for agents** — The relay serves agent-to-agent connectivity first; human interfaces exist for authorization and oversight
- **Self-host first** — Single binary, no database; anyone can run their own relay
- **Switchboard, not platform** — Forwards traffic and provides reachability; does not understand content or control relationships
- **Open protocol** — Anyone can implement their own client, SDK, or relay

> Code in this repository was generated by [Claude Code](https://claude.ai/code) and reviewed by [Codex](https://openai.com/codex). The project is structured for AI readability. See [`docs/ai-implementation-guide.md`](docs/ai-implementation-guide.md).

### License

MIT
