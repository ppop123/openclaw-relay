[中文](#中文) | [English](#english)

---

## 中文

# 安全

## Relay 可见性

Relay 是一个**盲转发器**（blind forwarder）。它无法读取、修改或检查经过它的消息内容。所有应用数据在客户端和网关之间端到端加密。Relay 只能看到：

- 由频道令牌派生的频道哈希（channel hash）——SHA-256 路由标识符
- 客户端 ID（client ID）——用于连接管理的不透明标识符
- 帧元数据（frame metadata）——方向、大小
- 加密后的密文块（ciphertext blob）

它**看不到**明文负载、API 密钥、用户提示词、模型响应或任何应用层数据。

## 密钥交换与会话密钥派生

加密流水线使用：

1. **X25519 ECDH** —— 网关和 SDK 身份使用长期 X25519 身份密钥对。浏览器参考客户端现在会在 IndexedDB 可用时持久化浏览器身份密钥对，同一浏览器配置文件中的重连和正常页面刷新会复用同一个 X25519 身份。如果 IndexedDB 不可用或持久化失败，浏览器退回到页面内存身份，刷新后重新生成。在所有情况下，共享密钥（shared secret）都通过当前长期身份密钥的 Diffie-Hellman 密钥协商派生。
2. **HKDF-SHA256** —— 共享密钥通过 HKDF（基于 SHA-256）扩展为 256 位会话密钥（session key）。双方各自的新鲜随机会话 nonce 混入 HKDF 盐值，确保每次连接的会话密钥唯一。
3. **AES-256-GCM** —— 所有帧使用派生的会话密钥通过 AES-256-GCM 进行加密和认证。

ECDH 共享密钥在各连接间相同（静态身份密钥），但会话密钥因每次连接双方各贡献一个新鲜的 32 字节随机 nonce 到 HKDF 盐值而唯一。泄露某个会话密钥不影响其他会话。但 v1 **不提供前向保密**——泄露身份私钥可以计算共享密钥，并结合捕获的 HELLO/HELLO_ACK 中的会话 nonce 派生出所有过去和未来的会话密钥。

## Nonce 结构

每个 AES-256-GCM nonce 为 12 字节，结构如下：

```
[4-byte direction][8-byte counter]
```

- **Direction**：`1` = 客户端到网关，`2` = 网关到客户端
- **Counter**：单调递增，每个方向从 0 开始

方向前缀防止两个通信方向的 nonce 重用，即使计数器值恰好相同。

## 防重放保护

每个方向维护一个 64 个计数器的**滑动窗口**（sliding window）。收到的帧会对照窗口检查：

- 每个方向的第一帧必须使用计数器 `0`。
- 计数器低于窗口下限的帧被拒绝。
- 计数器已在窗口内出现过的帧被拒绝。
- 合法帧推进窗口。

这在不要求严格有序到达的情况下防止重放攻击。

## 新鲜会话密钥

每次新连接生成：

- 新鲜的 32 字节随机会话 nonce（混入 HKDF 盐值）
- 从静态 ECDH 共享密钥和新鲜 nonce 派生的新 AES-256-GCM 会话密钥

网关和 SDK 身份密钥对是**静态的**，跨连接复用。浏览器参考客户端在 IndexedDB 可用时持久化身份密钥对，同一浏览器配置文件中的重连和正常刷新会复用该密钥对。如果持久化不可用，浏览器退回到页面内存身份，仅在页面刷新前复用。会话密钥因新鲜 nonce 而唯一。泄露某个会话密钥无法用于解密其他会话（不同 nonce 产生不同密钥）。但泄露身份私钥会危及由该身份派生的所有会话——参见上文前向保密说明。

## 网关密钥固定

当前浏览器参考客户端中，网关公钥验证使用**用户提供的固定公钥验证**（pinned gateway public-key verification）：

- 用户在连接表单中输入期望的网关公钥。
- 浏览器将该固定密钥持久化到安全设置中。
- 每次握手时，客户端验证 `hello_ack.gateway_public_key` 与固定值完全匹配。
- 如果密钥变化，握手被拒绝，视为潜在的中间人攻击（MITM）或配置错误。

这比自动首次信任（Trust On First Use）更强，因为浏览器客户端不会静默接受并存储首次观察到的密钥。目前没有证书颁发机构或 PKI 层；需要更强保证的用户应通过独立的可信通道或配对流程验证网关公钥。

## 浏览器存储策略

浏览器客户端只存储重连所需的最少数据：

| 项目 | 是否存储 | 原因 |
|------|----------|------|
| `relayUrl` | 是 | 需要重连到同一个 Relay |
| `gatewayPubKey` | 是 | 需要用于固定网关公钥验证 |
| `clientId` | 是 | 提供 Relay 层面的重连稳定性；它不是密码学身份 |
| `identityKeyPair` | **是，在 IndexedDB 可用时** | 仅存储在专用的 IndexedDB 身份存储中，使同一浏览器身份在重连和正常页面刷新后仍可用。如果 IndexedDB 不可用，客户端退回到仅页面内存。 |
| `channelToken` | **从不** | 持有者密钥——存储它会让任何能访问浏览器存储的人冒充用户 |

### 历史 channelToken 迁移

旧版客户端可能已将 `channelToken` 持久化到 local storage。加载时，当前客户端会自动检测并**删除**任何已保存的 `channelToken`。无需用户操作。

## 网关限定的发现边界

Layer 0.5 的发现和信令是**网关限定**（gateway-scoped）的，不是用户限定的：

- 面向人类的客户端只能与自己的 OpenClaw 实例通信。它们不能通过 Relay 发现或信令来发现、浏览或联系其他 OpenClaw 实例。
- Relay 可以向其他网关暴露可发现的网关公钥、不透明元数据和在线时间戳，但绝不能通过此接口暴露 `channel_hash` 或 `channel_token`。
- 信令负载对 Relay 来说是不透明的加密字节。
- 在 MVP 中，邀请别名（invite alias）是短期的、仅存于内存的、一次性的。原始邀请令牌只能在加密的网关到网关信令或其他网关控制的安全通道中传输。

这使 Relay 保持为 agent 的交换台，而非人类社交目录。

## Origin 验证

Relay 验证 WebSocket 升级请求的 `Origin` 头：

- **默认行为**：只接受**同源**请求和**无 Origin 头**的请求（SDK 和 CLI 工具等非浏览器客户端）。其他所有来源收到 `403 Forbidden` 响应。
- **跨域访问**：使用 `--allow-origin` 标志显式允许特定的跨域主机。只有列出的来源被允许，其他来源仍被阻止。

这防止未授权的浏览器客户端连接到 Relay，同时允许 SDK 和 CLI 客户端自由连接。

---

## English

# Security

## Relay Visibility

The relay is a **blind forwarder**. It cannot read, modify, or inspect the content of messages passing through it. All application data is end-to-end encrypted between the client and the gateway. The relay only sees:

- Channel hashes derived from channel tokens (SHA-256 routing identifiers)
- Client IDs (opaque identifiers for connection management)
- Frame metadata (direction, size)
- Encrypted ciphertext blobs

It does **not** see plaintext payloads, API keys, user prompts, model responses, or any application-layer data.

## Key Exchange and Session Key Derivation

The encryption pipeline uses:

1. **X25519 ECDH** -- Gateway and SDK identities use long-lived X25519 identity keypairs. The web reference client now persists its browser identity keypair in IndexedDB when available, so the same X25519 identity is reused across reconnects and normal page reloads in the same browser profile. If IndexedDB is unavailable or persistence fails, the browser falls back to a page-memory identity that is regenerated after reload. In every case, the shared secret is derived via Diffie-Hellman key agreement using the current long-lived identity keys for that client session.
2. **HKDF-SHA256** -- The shared secret is expanded into a 256-bit session key using HKDF with SHA-256. A fresh random session nonce from each side is mixed into the HKDF salt, ensuring a unique session key per connection.
3. **AES-256-GCM** -- All frames are encrypted and authenticated using AES-256-GCM with the derived session key.

The ECDH shared secret is the same across connections (static identity keys), but the session key is unique per connection because each side contributes a fresh 32-byte random nonce to the HKDF salt. A compromised session key does not affect other sessions. However, v1 does **not** provide forward secrecy — compromising an identity private key allows computing the shared secret and (combined with captured session nonces from HELLO/HELLO_ACK) deriving all past and future session keys.

## Nonce Structure

Each AES-256-GCM nonce is 12 bytes, structured as:

```
[4-byte direction][8-byte counter]
```

- **Direction**: `1` = client-to-gateway, `2` = gateway-to-client
- **Counter**: monotonically increasing, starting from 0 for each direction

The direction prefix prevents nonce reuse between the two communication directions, even if counters happen to match.

## Anti-Replay Protection

A **sliding window** of 64 counters is maintained per direction. Incoming frames are checked against this window:

- The first frame in each direction must use counter `0`.
- Frames with a counter below the window floor are rejected.
- Frames with a counter already seen within the window are rejected.
- Valid frames advance the window.

This prevents replay attacks without requiring strict in-order delivery.

## Fresh Session Keys

Every new connection generates:

- A fresh 32-byte random session nonce (mixed into the HKDF salt)
- A new AES-256-GCM session key derived from the static ECDH shared secret and the fresh nonces

Gateway and SDK identity keypairs are **static** and reused across connections. The browser reference client persists its identity keypair in IndexedDB when available, so it is reused across reconnects and normal reloads in the same browser profile. If persistence is unavailable, the browser falls back to a page-memory identity that is reused only until the page is reloaded. The session key is unique per connection because of the fresh nonces. If a session key is compromised, it cannot be used to decrypt other sessions (different nonces produce different keys). However, compromising an identity private key compromises all sessions derived from that identity — see the forward secrecy note above.

## Gateway Key Pinning

In the current web reference client, gateway public-key verification uses **user-supplied pinned gateway public-key verification**:

- The user enters the expected gateway public key in the connect form.
- The browser persists that pinned key in safe settings.
- On every handshake, the client verifies that `hello_ack.gateway_public_key` exactly matches the pinned value.
- If the key changes, the handshake is rejected as a potential MITM or misconfiguration.

This is stronger than automatic Trust On First Use because the browser client does not silently accept and store the first observed key. There is still no certificate authority or PKI layer; users who require stronger guarantees should verify the gateway public key through a separate trusted channel or through the pairing flow that produced the key.

## Browser Storage Policy

The web client stores only the minimum data needed for reconnection:

| Item | Stored | Reason |
|------|--------|--------|
| `relayUrl` | Yes | Needed to reconnect to the same relay |
| `gatewayPubKey` | Yes | Needed for pinned gateway public-key verification |
| `clientId` | Yes | Provides relay-level reconnection stability; it is not the cryptographic identity |
| `identityKeyPair` | **Yes, in IndexedDB when available** | Stored only in the dedicated IndexedDB identity store so the same browser identity can survive reconnects and normal page reloads. If IndexedDB is unavailable, the client falls back to page-memory only. |
| `channelToken` | **Never** | Bearer secret -- storing it would allow anyone with access to the browser storage to impersonate the user |

### Historical channelToken Migration

Older versions of the client may have persisted `channelToken` to local storage. On load, the current client automatically detects and **deletes** any saved `channelToken`. No user action is required.

## Gateway-Only Discovery Boundary

Layer 0.5 discovery and signaling are **gateway-scoped**, not human-scoped:

- Human-facing clients may talk only to their own OpenClaw instance. They must not discover, browse, or contact other OpenClaw instances through relay discovery or signaling.
- The relay may expose discoverable gateway public keys, opaque metadata, and online timestamps to other gateways, but it must never expose `channel_hash` or `channel_token` through this surface.
- Signal payloads remain opaque encrypted bytes to the relay.
- Invite aliases are short-lived, memory-only, and single-use in the MVP. The raw invite token must move only inside encrypted gateway-to-gateway signaling or another gateway-controlled secure channel.

This keeps the relay as an exchange for agents rather than a human social directory.

## Origin Validation

The relay validates the `Origin` header on incoming WebSocket upgrade requests:

- **Default behavior**: Only **same-origin** requests and requests with **no Origin header** (non-browser clients such as SDKs and CLI tools) are accepted. All other origins receive a `403 Forbidden` response.
- **Cross-origin access**: Use the `--allow-origin` flag to explicitly permit specific cross-origin hosts. Only listed origins will be allowed; all others remain blocked.

This prevents unauthorized browser-based clients from connecting to the relay while allowing SDK and CLI clients to connect freely.
