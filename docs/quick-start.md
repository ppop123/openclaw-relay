[中文](#中文) | [English](#english)

---

## 中文

# 快速上手

## 大多数人只需要这些

如果你的目标就是 **"从外面连回自己家里或办公室的 OpenClaw"**，最短路径是：

1. 启动一个 Relay 服务端
2. 在你的 OpenClaw 中安装 Relay 插件
3. 打开浏览器客户端，连接

这能给你什么：

- 远程访问 **你自己的** OpenClaw
- 不需要公网 IP
- 不需要端口映射
- 端到端加密（E2E encryption）的应用层流量

这 **不** 意味着：

- 这 **不是** 一个公共的 OpenClaw 实例目录
- 浏览器客户端 **不能** 浏览或连接其他人的 OpenClaw 实例
- 集群 / 多节点互联 / 高可用不在 v1 范围内

## 第一步：启动 Relay 服务端

```bash
cd relay
go build -o openclaw-relay
./openclaw-relay
```

Relay 默认监听 `8443` 端口。

检查是否启动成功：

```bash
curl http://localhost:8443/status
```

TLS、来源校验、Cloudflare Tunnel 及生产环境配置见 [部署指南](deployment.md)。

## 第二步：在你的 OpenClaw 中安装插件

安装插件：

```bash
openclaw plugins install --link /path/to/openclaw-relay/plugin
```

为本地 OpenClaw 网关启用 Relay 访问：

```bash
openclaw relay enable --server wss://relay.example.com/ws
openclaw relay status
```

准备从客户端连接时，首选在飞书 / Telegram 等聊天里给 OpenClaw 发送 `/relay_pair` 获取一键链接并直接点击。若没有聊天入口，再在终端启动配对：

```bash
openclaw relay pair
```

`openclaw relay pair` 会打印配对信息，并保持配对窗口开放（默认 5 分钟）。把输出里的 pairing link（`pairing.uri`）直接粘贴到客户端首页的 `Pairing link` 输入框。

如果浏览器客户端部署在固定地址，还可以直接生成一键连接链接：

```bash
openclaw relay pair --print-web-url --auto
```

终端会额外打印一个 Web client URL。浏览器打开这个链接后，会自动填入三个配对参数，并立即清理地址栏里的敏感 fragment。

常用的后续命令：

```bash
openclaw relay clients
openclaw relay revoke --fingerprint <fingerprint>
openclaw relay rotate-token
openclaw relay disable
```

## 第三步：从客户端连接

使用官方客户端连接：

- 浏览器路径：打开 `client/` 下的浏览器客户端
- 桌面路径：在 Windows/macOS 上使用 `desktop/` 下的桌面壳（同样优先粘贴 pairing link）
- 首选：把 `pairing.uri` 粘贴到客户端首页的 `Pairing link` 输入框
- 如果你用了 `--print-web-url`，浏览器会自动填入这些值
- 只有在需要时，才展开 `Manual setup` 手动输入 Relay 地址、通道令牌（channel token）和网关公钥（gateway public key）

然后点击连接。

客户端文档：

- [`docs/web-client.md`](web-client.md)
- [`docs/web-client/testing-and-troubleshooting.md`](web-client/testing-and-troubleshooting.md)

## 进阶：Agent 间通信能力

还有一个 **仅限 Agent** 的能力，可以让一个 OpenClaw Agent 与另一个 OpenClaw Agent 通信。

重要边界：

- 网关 / Agent 可以使用
- 浏览器客户端 **不能** 用来发现或连接其他 OpenClaw 实例

如果你需要这个功能，从这里开始：

- [`plugin/README.md`](../plugin/README.md)

## 开发检查

```bash
# Go relay server
cd relay && go test -v -count=1

# Python SDK
cd sdk/python && pip install -e ".[dev]" && pytest -q

# Web client
cd client && npm ci && npm test

# OpenClaw gateway plugin
cd plugin && npm ci && npm test
cd plugin && npm run typecheck
```

## 本地冒烟验证

完整的本地 OpenClaw 运行时冒烟测试：

```bash
bash scripts/smoke-openclaw-plugin.sh
```

该脚本会将 `plugin/` 安装到一个隔离的 OpenClaw 状态目录，启动本地 Relay，使用新的客户端身份完成配对，启动一个真实的 OpenClaw 网关，通过 Relay 验证 `system.status`，然后测试 `revoke`、重新配对、`rotate-token` 和 `disable` 行为。

---

## English

# Quick Start Guide

## Most people only need this

If your goal is simply **"I want to use my own OpenClaw from outside my home or office"**, the shortest path is:

1. Start a relay server
2. Install the relay plugin into your own OpenClaw
3. Open the browser client and connect

What this gives you:

- remote access to **your own** OpenClaw
- no public IP requirement
- no port forwarding
- end-to-end encrypted application traffic

What this does **not** mean:

- it is **not** a public directory of other people's OpenClaw instances
- human-facing clients do **not** browse or contact other OpenClaw instances
- clustering / federation / HA are not part of v1

## Step 1: Start a relay server

```bash
cd relay
go build -o openclaw-relay
./openclaw-relay
```

The relay listens on port `8443` by default.

Check that it is up:

```bash
curl http://localhost:8443/status
```

For TLS, origin validation, Cloudflare Tunnel, and production notes, see [Deployment Guide](deployment.md).

## Step 2: Install the plugin into your own OpenClaw

Install the plugin:

```bash
openclaw plugins install --link /path/to/openclaw-relay/plugin
```

Enable relay access for your local OpenClaw gateway:

```bash
openclaw relay enable --server wss://relay.example.com/ws
openclaw relay status
```

When you are ready to connect from the client, preferred is to send `/relay_pair` to OpenClaw via Feishu / Telegram (or your connected chat) and click the one-click link. If you do not have chat access, start pairing in one terminal:

```bash
openclaw relay pair
```

`openclaw relay pair` prints the pairing details and keeps the pairing window open (default 5 minutes). Copy the printed pairing link (`pairing.uri`) into the client's `Pairing link` field.

Useful day-2 commands:

```bash
openclaw relay clients
openclaw relay revoke --fingerprint <fingerprint>
openclaw relay rotate-token
openclaw relay disable
```

## Step 3: Connect from the client

Use the browser client in `client/` and connect via:

- preferred: the one-click link from `/relay_pair`
- otherwise: paste `pairing.uri` into the client's `Pairing link` field
- if you used `--print-web-url`, the browser fills the values automatically
- only if needed: expand `Manual setup` and enter the relay URL, channel token, and gateway public key

Then connect.

The browser client docs live here:

- [`docs/web-client.md`](web-client.md)
- [`docs/web-client/testing-and-troubleshooting.md`](web-client/testing-and-troubleshooting.md)

## Advanced: agent-only peer capability

There is also an **agent-only** capability that lets one OpenClaw agent talk to another OpenClaw agent.

Important boundary:

- gateways / agents may use it
- human-facing clients may **not** use it to find or contact other OpenClaw instances

If you want that flow, start here:

- [`plugin/README.md`](../plugin/README.md)

## Development checks

```bash
# Go relay server
cd relay && go test -v -count=1

# Python SDK
cd sdk/python && pip install -e ".[dev]" && pytest -q

# Web client
cd client && npm ci && npm test

# OpenClaw gateway plugin
cd plugin && npm ci && npm test
cd plugin && npm run typecheck
```

## Local smoke validation

For a real local OpenClaw runtime smoke test:

```bash
bash scripts/smoke-openclaw-plugin.sh
```

This script installs `plugin/` into an isolated OpenClaw state directory, starts a local relay, performs pairing with a fresh client identity, starts a real OpenClaw gateway, verifies `system.status` over the relay, then exercises `revoke`, re-pair, `rotate-token`, and `disable` behavior.
