# OpenClaw Relay Plugin

[中文](#中文) | [English](#english)

---

## 中文

OpenClaw Relay 网关插件。安装到你的 OpenClaw 运行时，即可将本地网关通过 Relay 服务暴露出去。

### 状态

- 已实现，CI 测试覆盖
- 已在真实 OpenClaw 运行时环境验证
- 作为 `v1.0.0` 正式支持
- 需要启用了 channel 和 CLI 插件 API 的最新 OpenClaw 运行时

### 功能概览

简单来说，这个插件把**你自己的 OpenClaw** 变成一个可通过 Relay 访问的网关。

具体来说：

- 你可以通过 Relay 连回自己的 OpenClaw
- 你可以配对/撤销浏览器或 SDK 客户端
- 你可以选择性开启新的 **agent 间 peer discovery 能力**

底层包含：

- Relay channel 配置和账号管理
- Layer 1 加密和会话建立
- Layer 2 请求/响应/流处理
- 配对状态和已授权客户端持久化
- CLI 命令：`enable`、`pair`、`clients`、`revoke`、`disable`、`rotate-token`、`status`

### 安装

```bash
openclaw plugins install --link /path/to/openclaw-relay/plugin
```

### 启用和配对

```bash
openclaw relay enable --server wss://relay.example.com/ws
openclaw relay enable --server wss://relay.example.com/ws --discoverable
openclaw relay enable --server wss://relay.example.com/ws --discoverable \
  --discover-label "Shanghai Lab" \
  --discover-metadata-json '{"region":"cn-sha","tier":"prod","capabilities":["peer-discovery"]}'
openclaw relay pair
openclaw relay pair --print-web-url
openclaw relay status
```

`openclaw relay pair --print-web-url` 会输出一个浏览器可直接打开的配对链接（默认指向 relay 自带的 `/client/` 页面）。链接中的敏感参数放在 URL fragment 中，浏览器读取后会立即清除，不会发给服务器。`--open-web` 会尝试自动打开默认浏览器。你也可以显式指定一个 base URL：`--print-web-url http://localhost:8080/client/`。

`--discoverable` 仅在操作员明确希望此网关加入 agent 间 discovery 层时使用。它**不会**开启任何面向人类用户的 peer 浏览界面。Discovery metadata 是可选的、由操作员控制的，且仅对同一 Relay 上的其他 discoverable 网关可见。

### 管理客户端

```bash
openclaw relay clients
openclaw relay revoke --fingerprint <fingerprint>
openclaw relay rotate-token
openclaw relay disable
```

### 管理面板权限

管理面板（技能/配置/日志/维护）仅依赖已批准客户端，不再需要额外的 admin key。

### Agent Discovery 边界

插件已实现 Relay 的网关间 Layer 0.5 控制面，但严格维护产品边界：

- 面向人类的客户端仍然只与自己的 OpenClaw 实例通信。
- 面向人类的客户端不得通过此插件浏览或联系其他 OpenClaw 实例。
- 操作员通过 OpenClaw 配置中的 `channels.relay.accounts.<id>.peerDiscovery.enabled` 控制是否可被发现。
- 插件当前复用网关的 X25519 身份作为 discovery 公钥，操作员可附加不透明的发现元数据（如标签、地域提示、能力标签等）。
- 网关内部方法包括 `discover`、`signal`、`invite_create`、invite 作用域的 peer 接受以及出站 invite 拨号，宿主仅通过本地 `createRelayAgentBridge(api)` 桥接和 `RelayPeerAgentService` 向 OpenClaw 内部和 agent 公开。
- Discovery 没有新增任何 Relay 请求/响应方法。远端人类客户端仍然无法通过 Layer 3 调用 `discover`、`signal` 或 `invite_create`。

### Discovery metadata 工作流

使用发现元数据让网关间发现对 agent 可用，同时不扩大面向人类的产品表面：

```bash
openclaw relay enable --server wss://relay.example.com/ws --account default \
  --discover-label "Shanghai Lab"

openclaw relay enable --server wss://relay.example.com/ws --account default \
  --discover-metadata-json '{"region":"cn-sha","tier":"prod","capabilities":["python","code"]}'

openclaw relay enable --server wss://relay.example.com/ws --account default \
  --clear-discovery-metadata
```

- `--discover-label` 仅更新人类可读标签，保留已有的发现元数据。
- `--discover-metadata-json` 用提供的 JSON 对象替换发现元数据；如果同时指定了 `--discover-label`，标签会合并在上层。
- `--clear-discovery-metadata` 移除 metadata 对象，但保留当前的 discoverability 设置。
- 这些选项不会向远端人类客户端暴露 discovery 控制；它们只修改操作员拥有的网关配置。

### 本地 peer 控制

网关运行后，所有者可以从**本地**网关控制面驱动 agent 间 peer discovery。

最简路径：

```bash
openclaw gateway call relay.peer.selfcheck --params '{}' --json
openclaw gateway call relay.peer.discover --params '{}' --json
openclaw gateway call relay.peer.call --params '{"peerPublicKey":"<peer-pubkey>","method":"system.status","params":{},"autoDial":true}' --json
```

如需更底层的步骤，仍然可用：

```bash
openclaw gateway call relay.peer.request --params '{"targetPublicKey":"<peer-pubkey>","body":{"purpose":"hello"}}' --json
openclaw gateway call relay.peer.poll --params '{}' --json
openclaw gateway call relay.peer.accept --params '{"signal":<poll-signal>,"ttlSeconds":60,"maxUses":1}' --json
openclaw gateway call relay.peer.connect --params '{"signal":<offer-signal>,"clientId":"peer-client-1"}' --json
openclaw gateway call relay.peer.dial --params '{"targetPublicKey":"<peer-pubkey>","clientId":"peer-client-1"}' --json
```

- 这些方法仅限本地网关 RPC 调用，不通过 Relay Layer 3 暴露。
- `relay.peer.selfcheck` 是最快的就绪探针：报告 Relay 注册状态、peer-discovery 标志、已连接 peer、已知 peer 会话状态，以及本地 OpenClaw 宿主是否暴露了 `chat.send` / history 所需的运行时组件。
- `relay.peer.call` 可在需要时自动建立 peer 会话，是操作员验证或使用 peer 的最简方式。
- `relay.peer.poll` 排空所选 Relay 账号的待处理信号和信号错误。
- `relay.peer.accept` 创建 invite 作用域的授权窗口和短期 invite token；不会泄露长期 channel token。
- `relay.peer.connect` 显式建立可复用的出站 peer 会话。
- `relay.peer.dial` 将 request + wait + connect 封装为单一操作员命令，在你需要单独检查连接建立过程（而非直接调用 peer）时仍然有用。

### 运行时要求

- Node.js `>=22`
- 支持 X25519 的 WebCrypto
- 插件集成测试套件需要 `PATH` 中有 Go 工具链
- 暴露了 channel + CLI 插件 API 的最新 OpenClaw 运行时构建

### 开发检查

```bash
cd plugin && npm ci
npm test
npm run typecheck
```

设计文档见 `docs/plans/2026-03-08-gateway-plugin-design.md`，快速安装流程见 `docs/quick-start.md`。

### 冒烟测试

在真实宿主上做本地冒烟验证：

```bash
cd plugin && npm run smoke
```

冒烟脚本使用 `.tmp/` 下的隔离 OpenClaw 状态/配置，启动本地 Relay，完成配对，通过真实 Relay 路径验证 `system.status` 请求，然后验证 `revoke`、重新配对、`rotate-token` 和 `disable` 行为。

### Peer 耐久测试

在两个真实 OpenClaw 网关上做耐久运行：

```bash
python3 scripts/peer-chat-soak.py --minutes 15
```

耐久脚本：
- 从两个宿主读取 `relay.peer.selfcheck`
- 双向建立 peer 会话
- 让两个 OpenClaw 实例在指定时长内互相对话
- 在 `.tmp/peer-chat-soak-*` 下输出 JSONL 记录和摘要

---

## English

This package contains the OpenClaw Relay gateway plugin. Install it into your own OpenClaw runtime to expose your local gateway through an OpenClaw Relay server.

### Status

- Implemented and covered by CI tests
- Verified locally against a real OpenClaw runtime build
- Officially supported as part of `v1.0.0`
- Requires a current OpenClaw runtime with channel and CLI plugin APIs enabled

### What it provides

In plain language, this plugin turns **your own OpenClaw** into a relay-reachable gateway.

That means:

- you can connect back to your own OpenClaw through a relay
- you can pair/revoke browser or SDK clients
- you can optionally enable the new **agent-only peer capability** between gateways

Under the hood it includes:

- relay channel configuration and account management
- Layer 1 crypto and session establishment
- Layer 2 request / response / stream handling
- pairing state and approved-client persistence
- CLI commands: `enable`, `pair`, `clients`, `revoke`, `disable`, `rotate-token`, `status`

### Install

```bash
openclaw plugins install --link /path/to/openclaw-relay/plugin
```

### Enable and pair

```bash
openclaw relay enable --server wss://relay.example.com/ws
openclaw relay enable --server wss://relay.example.com/ws --discoverable
openclaw relay enable --server wss://relay.example.com/ws --discoverable \
  --discover-label "Shanghai Lab" \
  --discover-metadata-json '{"region":"cn-sha","tier":"prod","capabilities":["peer-discovery"]}'
openclaw relay pair
openclaw relay pair --print-web-url
openclaw relay status
```

`openclaw relay pair --print-web-url` prints a browser-ready pairing handoff link (by default it points at the relay's built-in `/client/` page). Sensitive pairing parameters live in the URL fragment, so the browser reads them locally and then clears them without sending them to the server. `--open-web` also attempts to open the default browser automatically. You can still override the base URL via `--print-web-url http://localhost:8080/client/`.

Use `--discoverable` only when the operator explicitly wants this gateway to participate in the agent-only discovery layer. It does **not** enable any human-facing peer browsing UX. Discovery metadata is optional, operator-controlled, and only advertised to other discoverable gateways on the same relay.

### Manage clients

```bash
openclaw relay clients
openclaw relay revoke --fingerprint <fingerprint>
openclaw relay rotate-token
openclaw relay disable
```

### Management UI permissions

The admin panels (skills/config/logs/maintenance) now rely on approved clients only; no extra admin key is required.

### Agent Discovery Boundary

The plugin now understands the relay's gateway-only Layer 0.5 control plane, but it keeps the product boundary strict:

- Human-facing clients still talk only to their own OpenClaw instance.
- Human-facing clients must not browse or contact other OpenClaw instances through this plugin.
- Operator opt-in for discoverability is controlled by `channels.relay.accounts.<id>.peerDiscovery.enabled` in the OpenClaw config.
- The plugin currently reuses the gateway X25519 identity as the discovery public key and lets the operator attach opaque discovery metadata such as labels, region hints, or capability tags.
- Internal gateway-side methods exist for `discover`, `signal`, `invite_create`, invite-scoped peer acceptance, and outbound invite dialing, and the host now exposes them only through the local `createRelayAgentBridge(api)` bridge and `RelayPeerAgentService` for OpenClaw internals and agents.
- No new relay request/response methods were added for discovery. Remote human clients still cannot call `discover`, `signal`, or `invite_create` through Layer 3.

### Discovery metadata workflow

Use discovery metadata to make gateway-to-gateway discovery usable for agents without widening the human-facing product surface:

```bash
openclaw relay enable --server wss://relay.example.com/ws --account default \
  --discover-label "Shanghai Lab"

openclaw relay enable --server wss://relay.example.com/ws --account default \
  --discover-metadata-json '{"region":"cn-sha","tier":"prod","capabilities":["python","code"]}'

openclaw relay enable --server wss://relay.example.com/ws --account default \
  --clear-discovery-metadata
```

- `--discover-label` updates just the human-readable label and preserves any existing discovery metadata.
- `--discover-metadata-json` replaces discovery metadata with the provided JSON object; if `--discover-label` is also present, the label is merged on top.
- `--clear-discovery-metadata` removes the metadata object but preserves the current discoverability setting.
- These flags never expose discovery controls to remote human clients; they only change operator-owned gateway config.

### Local peer control

Once the gateway is running, the owner can drive agent-only peer discovery from the **local** gateway control plane.

The shortest useful path is:

```bash
openclaw gateway call relay.peer.selfcheck --params '{}' --json
openclaw gateway call relay.peer.discover --params '{}' --json
openclaw gateway call relay.peer.call --params '{"peerPublicKey":"<peer-pubkey>","method":"system.status","params":{},"autoDial":true}' --json
```

If you want the lower-level steps, they are still available:

```bash
openclaw gateway call relay.peer.request --params '{"targetPublicKey":"<peer-pubkey>","body":{"purpose":"hello"}}' --json
openclaw gateway call relay.peer.poll --params '{}' --json
openclaw gateway call relay.peer.accept --params '{"signal":<poll-signal>,"ttlSeconds":60,"maxUses":1}' --json
openclaw gateway call relay.peer.connect --params '{"signal":<offer-signal>,"clientId":"peer-client-1"}' --json
openclaw gateway call relay.peer.dial --params '{"targetPublicKey":"<peer-pubkey>","clientId":"peer-client-1"}' --json
```

- These methods are local gateway RPC only; they are not exposed through relay Layer 3.
- `relay.peer.selfcheck` is the quickest readiness probe: it reports relay registration, peer-discovery flags, connected peers, known peer-session state, and whether the local OpenClaw host exposes the runtime pieces needed for `chat.send` / history.
- `relay.peer.call` can now auto-establish a peer session when needed, so it is the simplest operator-facing way to verify or use a peer.
- `relay.peer.poll` drains pending signals and signal errors for the selected relay account.
- `relay.peer.accept` creates an invite-scoped authorization window plus a short-lived invite token; it never reveals the long-lived channel token.
- `relay.peer.connect` establishes a reusable outbound peer session explicitly.
- `relay.peer.dial` wraps request + wait + connect into a single operator-facing step and remains useful when you want to inspect connection setup separately from the actual peer call.

### Runtime requirements

- Node.js `>=22`
- WebCrypto with X25519 support
- Go toolchain on `PATH` for the plugin integration test suite
- A current OpenClaw runtime build that exposes channel + CLI plugin APIs

### Development checks

```bash
cd plugin && npm ci
npm test
npm run typecheck
```

See `docs/plans/2026-03-08-gateway-plugin-design.md` for the design source and `docs/quick-start.md` for the short install flow.

### Smoke validation

For a real-host local smoke check:

```bash
cd plugin && npm run smoke
```

The smoke script uses an isolated OpenClaw state/config under `.tmp/`, starts a local relay, completes pairing, verifies a `system.status` request over the real relay path, then validates `revoke`, re-pair, `rotate-token`, and `disable` behavior.

### Peer soak validation

For a real two-host durability run against live OpenClaw gateways:

```bash
python3 scripts/peer-chat-soak.py --minutes 15
```

The soak script:
- reads `relay.peer.selfcheck` from both hosts
- establishes peer sessions in both directions
- lets the two OpenClaw instances talk to each other for the requested duration
- writes a JSONL transcript plus summary under `.tmp/peer-chat-soak-*`
