[中文](#中文) | [English](#english)

---

## 中文

# 部署与运维

> **错误码参考：** 完整的机器可读错误码列表见 [`protocol/error-codes.json`](../protocol/error-codes.json)。

## 前置条件

- **Go 1.24+**

## 构建

```bash
cd relay
go build -o openclaw-relay
```

## 运行

基本用法：

```bash
./openclaw-relay
```

### CLI 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | `8443` | 监听端口 |
| `--tls` | `off` | TLS 模式：`off`、`auto` 或 `manual` |
| `--cert` | | TLS 证书文件路径（manual 模式） |
| `--key` | | TLS 私钥文件路径（manual 模式） |
| `--domain` | | ACME/Let's Encrypt 域名（auto 模式） |
| `--max-channels` | `500` | 最大活跃频道数 |
| `--max-clients-per-channel` | `10` | 每个频道最大客户端数 |
| `--rate-limit` | `100` | 每个频道每秒最大消息数 |
| `--max-payload` | `1048576` | 最大帧负载大小（字节），默认 1MB |
| `--public` | `false` | 在 /status 中将本节点标记为公共实例 |
| `--log-format` | `text` | 日志格式：`text` 或 `json` |
| `--allow-origin` | | 允许的来源主机名（逗号分隔），例如 `myapp.com,*.example.com` |

## TLS 模式

### 关闭（仅开发环境）

```bash
./openclaw-relay
```

传输层不加密。仅限本地开发使用。该模式下 Relay 不处理 TLS；生产环境请使用反向代理。

### 自动（ACME / Let's Encrypt）

```bash
./openclaw-relay --tls auto --domain relay.example.com
```

通过 Let's Encrypt 自动获取和续期 TLS 证书。要求：

- `--domain` 必须设置为可公网解析的域名
- **80** 端口必须可达，用于 HTTP-01 验证（Relay 会自动监听 `:80`）
- **443** 端口用于 TLS 监听

### 手动

```bash
./openclaw-relay --tls manual --cert /path/to/cert.pem --key /path/to/key.pem
```

使用指定的证书和私钥文件。`--cert` 和 `--key` 两个参数缺一不可。

## 来源验证

默认情况下，Relay 只接受**同源** WebSocket 连接和**不携带 Origin 头**的连接（非浏览器客户端）。来自其他来源的浏览器连接会收到 `403 Forbidden`。

如需允许特定的跨域浏览器客户端，用逗号分隔传入**主机名模式**（不是完整 URL）：

```bash
./openclaw-relay --allow-origin app.example.com,*.example.com
```

## /status 接口

`GET /status` 返回 Relay 的健康状态和指标：

```json
{
  "name": "openclaw-relay",
  "version": "0.8.0",
  "protocol_version": 1,
  "channels_active": 12,
  "channels_limit": 500,
  "connections_total": 34,
  "frames_forwarded_total": 98210,
  "frames_rejected_total": 7,
  "uptime_seconds": 86400,
  "public": false
}
```

## 容量规划

| 资源 | 默认值 | 备注 |
|------|--------|------|
| 每频道内存 | ~10 KB | 包含连接状态和缓冲区 |
| 最大频道数 | 500 | 用 `--max-channels` 调整 |
| 每频道最大客户端数 | 10 | 用 `--max-clients-per-channel` 调整 |
| 速率限制 | 100 msg/s per channel | 用 `--rate-limit` 调整 |
| 最大负载 | 1 MB | 用 `--max-payload` 调整 |

默认配置下，500 个频道全部活跃时，频道状态约占 5 MB 内存，加上 WebSocket 连接开销。

## 错误码

Relay 在关闭帧和错误响应中返回结构化错误码：

| 错误码 | 含义 |
|--------|------|
| `invalid_frame` | 帧无法解析或格式错误 |
| `channel_occupied` | 该频道已有另一个网关注册 |
| `channel_full` | 频道已达 `--max-clients-per-channel` 上限 |
| `payload_too_large` | 帧负载超过 `--max-payload` 限制 |
| `rate_limited` | 频道超过 `--rate-limit` 的每秒消息上限 |
| `client_id_required` | 客户端未提供 client ID |

## 故障排查

**"Connection refused"**
检查 Relay 是否在运行、端口是否正确、防火墙是否允许入站连接。如果使用 TLS auto 模式，确认 80 和 443 端口都可访问。

**"403 Forbidden"**
来源不匹配。浏览器的 Origin 不在允许列表中。用 `--allow-origin your-app.example.com` 添加。

**"channel_occupied"**
该频道令牌已有另一个网关注册。每个频道只支持一个网关。检查是否有残留的网关进程在运行。

**"payload_too_large"**
帧超过最大负载限制。减小发送端的负载大小，或用 `--max-payload` 增大限制。

**"rate_limited"**
频道每秒发送消息数超过配置上限。降低发送频率，或用 `--rate-limit` 增大限制。

**握手超时**
网关离线或因网络问题不可达。确认网关进程正在运行且能访问 Relay。

**client_id 重复**
客户端用相同 client ID 重连时，旧连接会被替换。这是正常行为，确保重连稳定性。旧连接会被干净地关闭。

## 优雅关闭

发送 `SIGTERM` 或 `SIGINT` 触发优雅关闭：

1. Relay 停止接受新连接。
2. 向现有连接发送关闭帧。
3. 等待最多 **10 秒**让进行中的帧完成传输。
4. 关闭所有连接，进程退出。

## 日志

生产环境建议用 `--log-format json` 输出结构化日志。每行一个 JSON 对象，方便日志聚合系统采集。

```bash
./openclaw-relay --log-format json
```

文本格式（默认）适用于本地开发和人工查看。

## 安装 OpenClaw Gateway 插件

将插件安装到你的 OpenClaw 运行时：

```bash
openclaw plugins install --link /path/to/openclaw-relay/plugin
```

启用并与 Relay 配对：

首选方式是在飞书 / Telegram 等聊天里给 OpenClaw 发送 `/relay_pair`，拿到一键配对链接后直接点击。若无法走聊天入口，再用 CLI：

```bash
openclaw relay enable --server wss://relay.example.com/ws
openclaw relay pair
openclaw relay status
```

常用运维命令：

```bash
openclaw relay clients
openclaw relay revoke --fingerprint <fingerprint>
openclaw relay rotate-token
openclaw relay disable
```

---

## English

# Deployment and Operations

> **Error codes reference:** See [`protocol/error-codes.json`](../protocol/error-codes.json) for the canonical machine-readable list.

## Prerequisites

- **Go 1.24+**

## Building

```bash
cd relay
go build -o openclaw-relay
```

## Running

Basic usage:

```bash
./openclaw-relay
```

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `8443` | Listen port |
| `--tls` | `off` | TLS mode: `off`, `auto`, or `manual` |
| `--cert` | | Path to TLS certificate file (manual TLS mode) |
| `--key` | | Path to TLS private key file (manual TLS mode) |
| `--domain` | | Domain name for ACME/Let's Encrypt (auto TLS mode) |
| `--max-channels` | `500` | Maximum number of active channels |
| `--max-clients-per-channel` | `10` | Maximum clients per channel |
| `--rate-limit` | `100` | Maximum messages per second per channel |
| `--max-payload` | `1048576` | Maximum frame payload size in bytes (default 1MB) |
| `--public` | `false` | Expose relay as a public instance in /status |
| `--log-format` | `text` | Log format: `text` or `json` |
| `--allow-origin` | | Comma-separated allowed origin host patterns (e.g. `myapp.com,*.example.com`) |

## TLS Modes

### Off (development only)

```bash
./openclaw-relay
```

No encryption on the transport layer. Use only for local development. The relay itself does not handle TLS; place it behind a reverse proxy for production if using this mode.

### Auto (ACME / Let's Encrypt)

```bash
./openclaw-relay --tls auto --domain relay.example.com
```

Automatically obtains and renews TLS certificates via Let's Encrypt. Requires:

- `--domain` must be set to a publicly resolvable domain name
- Port **80** must be reachable for HTTP-01 challenges (the relay listens on `:80` automatically)
- Port **443** is used for the TLS listener

### Manual

```bash
./openclaw-relay --tls manual --cert /path/to/cert.pem --key /path/to/key.pem
```

Uses the provided certificate and key files. Both `--cert` and `--key` are required.

## Origin Validation

By default, the relay accepts only **same-origin** WebSocket connections and connections with **no Origin header** (non-browser clients). Browser clients from other origins receive `403 Forbidden`.

To allow specific cross-origin browser clients, pass a comma-separated list of **host patterns** (not full URLs):

```bash
./openclaw-relay --allow-origin app.example.com,*.example.com
```

## /status Endpoint

`GET /status` returns a JSON object with relay health and metrics:

```json
{
  "name": "openclaw-relay",
  "version": "0.8.0",
  "protocol_version": 1,
  "channels_active": 12,
  "channels_limit": 500,
  "connections_total": 34,
  "frames_forwarded_total": 98210,
  "frames_rejected_total": 7,
  "uptime_seconds": 86400,
  "public": false
}
```

## Capacity Planning

| Resource | Default | Notes |
|----------|---------|-------|
| Memory per channel | ~10 KB | Includes connection state and buffers |
| Max channels | 500 | Adjust with `--max-channels` |
| Max clients per channel | 10 | Adjust with `--max-clients-per-channel` |
| Rate limit | 100 msg/s per channel | Adjust with `--rate-limit` |
| Max payload | 1 MB | Adjust with `--max-payload` |

A relay with default settings and all 500 channels active uses approximately 5 MB of memory for channel state, plus overhead for WebSocket connections.

## Error Codes

The relay returns structured error codes in close frames and error responses:

| Code | Meaning |
|------|---------|
| `invalid_frame` | Frame could not be parsed or is malformed |
| `channel_occupied` | Another gateway is already registered on this channel |
| `channel_full` | Channel has reached `--max-clients-per-channel` |
| `payload_too_large` | Frame payload exceeds `--max-payload` |
| `rate_limited` | Channel exceeded `--rate-limit` messages per second |
| `client_id_required` | Client did not provide a client ID |

## Troubleshooting

**"Connection refused"**
Check that the relay is running, the port is correct, and firewall rules allow inbound connections. If using TLS auto mode, verify that both port 80 and 443 are accessible.

**"403 Forbidden"**
Origin mismatch. The connecting browser's origin is not in the allow list. Add the origin host with `--allow-origin your-app.example.com`.

**"channel_occupied"**
Another gateway has already registered on this channel token. Each channel supports exactly one gateway. Verify that you do not have a stale gateway process running.

**"payload_too_large"**
The frame exceeds the maximum payload size. Either reduce the payload size on the sender side or increase the limit with `--max-payload`.

**"rate_limited"**
The channel is sending more messages per second than the configured limit. Reduce message frequency or increase the limit with `--rate-limit`.

**Handshake timeout**
The gateway is offline or unreachable due to a network issue. Verify the gateway process is running and can reach the relay.

**Duplicate client_id**
When a client reconnects with the same client ID, the old connection is replaced. This is normal behavior and ensures reconnection stability. The old connection will be closed cleanly.

## Graceful Shutdown

Sending `SIGTERM` or `SIGINT` triggers a clean shutdown:

1. The relay stops accepting new connections.
2. Existing connections are notified with a close frame.
3. The relay waits up to **10 seconds** for in-flight frames to complete.
4. All connections are closed and the process exits.

## Logging

Use `--log-format json` for structured logging in production environments. This produces one JSON object per log line, suitable for ingestion by log aggregation systems.

```bash
./openclaw-relay --log-format json
```

Text format (default) is intended for local development and human reading.


## Installing the OpenClaw Gateway Plugin

Install the plugin into your own OpenClaw runtime:

```bash
openclaw plugins install --link /path/to/openclaw-relay/plugin
```

Then enable and pair it against your relay:

Preferred: send `/relay_pair` to OpenClaw via Feishu / Telegram (or your connected chat) and click the returned one-click link. If you must use the CLI, run:

```bash
openclaw relay enable --server wss://relay.example.com/ws
openclaw relay pair
openclaw relay status
```

Useful operational commands:

```bash
openclaw relay clients
openclaw relay revoke --fingerprint <fingerprint>
openclaw relay rotate-token
openclaw relay disable
```
