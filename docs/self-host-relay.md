[中文](#中文) | [English](#english)

---

## 中文

# 自建 Relay 节点

> **⚠ 本文描述的是规划中的体验。** 预构建二进制和 Docker 镜像尚未发布。目前运行 Relay 需要从源码构建——参见 [`deployment.md`](deployment.md) 了解当前流程。

## 环境要求

- 一台有公网 IP 的机器（VPS、云实例、配置了端口转发的家庭服务器）
- 443 端口（或其他端口）可从公网访问
- 可选：域名（自动 TLS 需要）

## 快速开始

### 方式一：二进制文件

下载对应平台的最新版本：

```bash
# Linux amd64
curl -L https://github.com/openclaw/relay/releases/latest/download/openclaw-relay-linux-amd64 -o openclaw-relay
chmod +x openclaw-relay

# macOS arm64
curl -L https://github.com/openclaw/relay/releases/latest/download/openclaw-relay-darwin-arm64 -o openclaw-relay
chmod +x openclaw-relay
```

使用自动 TLS 运行（需要域名已解析到本机）：

```bash
./openclaw-relay --port 443 --tls auto --domain relay.yourdomain.com
```

不使用 TLS 运行（放在 nginx/Caddy 等反向代理后面）：

```bash
./openclaw-relay --port 8443 --tls off
```

### 方式二：Docker

```bash
docker run -d \
  --name openclaw-relay \
  -p 443:443 \
  ghcr.io/openclaw/relay \
  --tls auto --domain relay.yourdomain.com
```

### 方式三：Docker Compose

```yaml
services:
  relay:
    image: ghcr.io/openclaw/relay
    ports:
      - "443:443"
    command: --tls auto --domain relay.yourdomain.com --public
    restart: unless-stopped
```

## 反向代理配置

如果已经有 nginx 或 Caddy，让它们处理 TLS：

**Caddy：**

```
relay.yourdomain.com {
    reverse_proxy localhost:8443
}
```

**nginx：**

```nginx
server {
    listen 443 ssl;
    server_name relay.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

然后以无 TLS 模式启动 Relay：

```bash
./openclaw-relay --port 8443 --tls off
```

## 公开你的节点

把你的 Relay 共享给社区：

1. 启动时加上 `--public` 参数
2. 确认 `/status` 端点可访问：
   ```bash
   curl https://relay.yourdomain.com/status
   ```
3. Fork openclaw-relay 仓库
4. 把你的节点信息加到 `relays.json`：
   ```json
   {
     "url": "wss://relay.yourdomain.com",
     "region": "cn-east",
     "operator": "your-github-username",
     "operator_url": "https://github.com/your-username",
     "capacity": 500,
     "since": "2026-03-07"
   }
   ```
5. 提交 Pull Request

## 监控

Relay 日志输出到 stdout，关键日志行：

```
INFO  relay started on :443
INFO  channel opened: a8f3c2... (gateway connected)
INFO  channel joined: a8f3c2... (client abc123)
WARN  rate limited: a8f3c2... (exceeded 100 msg/s)
INFO  channel closed: a8f3c2... (gateway disconnected)
```

生产环境建议使用 JSON 格式日志：

```bash
./openclaw-relay --port 8443 --tls off --log-format json
```

通过 `/status` 端点监控关键指标：

| 指标 | 告警阈值 |
|------|----------|
| `channels_active` / `channels_limit` | > 80% |
| `connections_total` | 突然下降说明网络异常 |
| `frames_rejected_total` | 持续上升说明存在滥用 |

定期检查 `/status`：

```bash
watch -n 30 'curl -s https://relay.yourdomain.com/status | jq .'
```

## 运维须知

- **重启行为**：Relay 不保存任何持久状态。重启后所有频道（Channel）断开，已连接的 Gateway 和客户端会自动以指数退避重连。
- **优雅关停**：发送 SIGTERM。Relay 会以 1001（Going Away）关闭码断开所有 WebSocket 连接。客户端应将此视为临时断连。
- **滥用处理**：Relay 按频道做速率限制和消息大小限制。违规连接会收到错误帧并被断开。v1 不做 IP 封禁——如有需要请用防火墙规则。
- **仅单节点（v1）**：不要在负载均衡器后面跑多个 Relay 实例。WebSocket 连接是有状态的，频道状态不会在实例间共享。

## 资源占用

Relay 极其轻量：

- **内存**：基础约 50 MB + 每活跃频道约 10 KB
- **CPU**：几乎可忽略（只转发字节流）
- **带宽**：与用户流量成正比（Relay 不增加额外开销）
- **磁盘**：零（无持久化）

一台每月 $5 的 VPS 就能撑住数百个并发频道。

---

## English

# Self-Hosting a Relay

> **⚠ This document describes a planned future experience.** Pre-built binaries and Docker images are not yet available. To run a relay today, build from source — see [`deployment.md`](deployment.md) for the current workflow.

## Requirements

- A machine with a public IP (VPS, cloud instance, home server with port forwarding)
- Port 443 (or any port) accessible from the internet
- Optional: a domain name (required for auto TLS)

## Quick Start

### Option 1: Binary

Download the latest release for your platform:

```bash
# Linux amd64
curl -L https://github.com/openclaw/relay/releases/latest/download/openclaw-relay-linux-amd64 -o openclaw-relay
chmod +x openclaw-relay

# macOS arm64
curl -L https://github.com/openclaw/relay/releases/latest/download/openclaw-relay-darwin-arm64 -o openclaw-relay
chmod +x openclaw-relay
```

Run with auto TLS (requires a domain pointed to this machine):

```bash
./openclaw-relay --port 443 --tls auto --domain relay.yourdomain.com
```

Run without TLS (behind a reverse proxy like nginx/Caddy):

```bash
./openclaw-relay --port 8443 --tls off
```

### Option 2: Docker

```bash
docker run -d \
  --name openclaw-relay \
  -p 443:443 \
  ghcr.io/openclaw/relay \
  --tls auto --domain relay.yourdomain.com
```

### Option 3: Docker Compose

```yaml
services:
  relay:
    image: ghcr.io/openclaw/relay
    ports:
      - "443:443"
    command: --tls auto --domain relay.yourdomain.com --public
    restart: unless-stopped
```

## Behind a Reverse Proxy

If you already run nginx or Caddy, let them handle TLS:

**Caddy:**

```
relay.yourdomain.com {
    reverse_proxy localhost:8443
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name relay.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

Then run the relay without TLS:

```bash
./openclaw-relay --port 8443 --tls off
```

## Making It Public

To share your relay with the community:

1. Add the `--public` flag when starting the relay
2. Verify the `/status` endpoint is accessible:
   ```bash
   curl https://relay.yourdomain.com/status
   ```
3. Fork the openclaw-relay repository
4. Add your relay to `relays.json`:
   ```json
   {
     "url": "wss://relay.yourdomain.com",
     "region": "cn-east",
     "operator": "your-github-username",
     "operator_url": "https://github.com/your-username",
     "capacity": 500,
     "since": "2026-03-07"
   }
   ```
5. Submit a pull request

## Monitoring

The relay logs to stdout. Key log lines:

```
INFO  relay started on :443
INFO  channel opened: a8f3c2... (gateway connected)
INFO  channel joined: a8f3c2... (client abc123)
WARN  rate limited: a8f3c2... (exceeded 100 msg/s)
INFO  channel closed: a8f3c2... (gateway disconnected)
```

For JSON structured logging (recommended for production), start with:

```bash
./openclaw-relay --port 8443 --tls off --log-format json
```

Key metrics to monitor via the `/status` endpoint:

| Metric | Warning threshold |
|--------|------------------|
| `channels_active` / `channels_limit` | > 80% |
| `connections_total` | Sudden drops indicate network issues |
| `frames_rejected_total` | Sustained increase indicates abuse |

Monitor the `/status` endpoint for health:

```bash
watch -n 30 'curl -s https://relay.yourdomain.com/status | jq .'
```

## Operational Notes

- **Restart behavior**: The relay holds no persistent state. On restart, all channels are dropped. Connected gateways and clients will automatically reconnect with exponential backoff.
- **Graceful shutdown**: Send SIGTERM. The relay will close all WebSocket connections with a 1001 (Going Away) close code. Clients should treat this as a transient disconnection.
- **Abuse handling**: The relay enforces per-channel rate limits and payload size caps. Abusive connections are terminated with an error frame. No IP banning in v1 — use firewall rules if needed.
- **Single-node only (v1)**: Do not run multiple relay instances behind a load balancer. WebSocket connections are stateful and channel state is not shared between instances.

## Resource Usage

The relay is extremely lightweight:

- **Memory**: ~50 MB base + ~10 KB per active channel
- **CPU**: Negligible (just forwarding bytes)
- **Bandwidth**: Proportional to user traffic (relay adds no overhead)
- **Disk**: Zero (no persistence)

A $5/month VPS can handle hundreds of concurrent channels.
