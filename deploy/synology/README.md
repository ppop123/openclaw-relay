# Synology NAS 部署：Relay + 内置 Web Client（/client/）

目标：让用户从飞书点开链接即可使用：`https://<你的域名>/client/#...`。

这份部署方式的关键点是：**Web Client 静态文件由 Relay 同机同域提供**（`/client/`），从而避免“本地起静态服务 + Origin allowlist”的复杂度。

## 0) 前置假设

- 你的公网入口（例如 Cloudflare Tunnel）已经把外网域名转发到 NAS 上的 relay 端口（示例 `8443`）。
- relay 以 `--tls off` 运行（TLS 由 Cloudflare 终止）。

## 1) 选择 NAS 架构（仅第一次需要）

在 NAS 上执行：

```bash
uname -m
```

- 常见返回：
  - `x86_64` → 选择 `linux/amd64`
  - `aarch64` / `arm64` → 选择 `linux/arm64`

## 2) 在开发机上构建 relay 二进制（macOS 上交叉编译）

在本仓库根目录执行：

```bash
cd relay

# x86_64 NAS
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../dist/openclaw-relay-linux-amd64 .

# arm64 NAS（如果需要）
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o ../dist/openclaw-relay-linux-arm64 .
```

## 3) 准备“运行目录”

Relay 需要同目录（或指定目录）里有 web client 静态文件：

- `client/index.html` 必须存在
- 建议把整个仓库的 `client/` 目录复制到 NAS

推荐在 NAS 上准备一个目录（示例）：

```
/volume1/docker/openclaw-relay/
  bin/
    openclaw-relay
  client/
    index.html
    js/
    css/
    ...
  log/
    relay.log
```

## 4) 拷贝文件到 NAS

从开发机复制（示例路径，按你的实际目录改）：

```bash
# 复制二进制
scp dist/openclaw-relay-linux-amd64 zf@192.168.50.5:/volume1/docker/openclaw-relay/bin/openclaw-relay

# 复制 client 静态目录
rsync -av --delete client/ zf@192.168.50.5:/volume1/docker/openclaw-relay/client/
```

然后在 NAS 上：

```bash
chmod +x /volume1/docker/openclaw-relay/bin/openclaw-relay
```

## 5) 启动命令（关键参数）

如果 relay 二进制运行目录在 `/volume1/docker/openclaw-relay/bin/`，而静态文件在 `/volume1/docker/openclaw-relay/client/`，建议显式指定：

```bash
/volume1/docker/openclaw-relay/bin/openclaw-relay \
  --port 8443 \
  --tls off \
  --log-format json \
  --client-dir /volume1/docker/openclaw-relay/client
```

说明：

- `--client-dir` 开启 `/client/` 托管
- 页面与 WebSocket 同域时，通常不需要 `--allow-origin`（默认安全策略即可）

## 6) 验收

在 NAS 上：

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8443/client/
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8443/status
```

预期：`/client/` 与 `/status` 都返回 `200`。

在外网（你的电脑）上：

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://relay.wanghui.cc/client/
```

预期：返回 `200`。

## 7) 与 OpenClaw 配对链接的配合

当 `/client/` 正常后：

- 在飞书里发 `/relay_pair`
- OpenClaw 会回你 `https://<relay-host>/client/#...&auto=1`
- 直接点开即可

