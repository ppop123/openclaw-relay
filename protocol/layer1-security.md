# Layer 1: Security Layer

All communication between client and gateway is end-to-end encrypted. The relay cannot read, modify, or forge messages.

## Cryptographic Primitives

| Purpose | Algorithm |
|---------|-----------|
| Key exchange | X25519 (Curve25519 ECDH) |
| Symmetric encryption | AES-256-GCM |
| Key derivation | HKDF-SHA256 |
| Message authentication | Included in AES-GCM (AEAD) |

These are widely available in all major languages and platforms (WebCrypto API, Go stdlib, Python cryptography, libsodium).

## Key Exchange: Pairing

Pairing happens once per client. It authorizes that client's public key on the gateway. Session keys are still derived per connection and MUST NOT be reused across reconnects.

### Step 1: Gateway generates identity

When the user enables relay mode, the gateway generates:

- An X25519 keypair: `(gateway_private_key, gateway_public_key)`
- A channel token with **at least 96 bits of entropy**. Examples in this document use shortened values such as `kx8f-a3mv-9pqz` for readability; production implementations SHOULD use a longer Base32/Base64url encoding.

The gateway stores `gateway_private_key` and `channel_token` locally.

### Step 2: Gateway displays pairing info

The pairing info is presented to the user (QR code or text) when the user explicitly runs `openclaw relay pair`. This places the gateway into a short-lived pairing mode for exactly one new client.

The pairing window MUST have a timeout (suggested: 5 minutes). After the timeout, or after one successful pairing, the gateway exits pairing mode and rejects unknown client keys. The gateway MUST NOT auto-accept unknown client keys outside of pairing mode. This is a hard security requirement.

```
relay:   wss://relay.example.com
token:   kx8f-a3mv-9pqz
pubkey:  base64(gateway_public_key)
fp:      sha256(gateway_public_key)[0:16]
```

As a compact URI for QR encoding:

```
openclaw-relay://relay.example.com/kx8f-a3mv-9pqz#base64(gateway_public_key)
```

### Step 3: Client completes pairing

The client (via QR scan or manual entry) receives:
- `relay_url`
- `channel_token`
- `gateway_public_key`

The client stores the gateway public key (or its fingerprint) as the gateway identity for later verification.

The client generates its own X25519 keypair: `(client_private_key, client_public_key)`.

Both sides compute the shared secret:

```
shared_secret = X25519(own_private_key, peer_public_key)
```

### Step 4: HELLO exchange

After both connect to the relay and the Layer 0 handshake completes, the client sends a HELLO message (via Layer 0 DATA frame):

```json
{
  "type": "hello",
  "client_public_key": "<base64>",
  "session_nonce": "<base64-12-32-bytes-random>",
  "protocol_version": 1,
  "capabilities": ["chat", "stream", "notify"]
}
```

This message is sent **unencrypted** (the public key is not sensitive). It is the only unencrypted application message.

If the gateway does not already trust `client_public_key`, it MUST only accept it while pairing mode is active. On first successful pairing, the gateway stores the client's public key under the presented `client_id` and exits pairing mode.

The gateway responds with its own HELLO:

```json
{
  "type": "hello_ack",
  "gateway_public_key": "<base64>",
  "session_nonce": "<base64-12-32-bytes-random>",
  "protocol_version": 1,
  "capabilities": ["chat", "stream", "notify", "agents", "cron", "files"]
}
```

#### Gateway Identity Pinning

The client MUST verify that `gateway_public_key` matches the expected pinned gateway identity, whether that key came from pairing data or another trusted out-of-band source. On subsequent connections, the client MUST compare the received `gateway_public_key` against that pinned value. If the key has changed unexpectedly, the client MUST refuse the connection and alert the user. This uses explicit gateway key pinning, not automatic Trust-On-First-Use acceptance. If verification fails, the connection MUST be aborted.

After HELLO exchange, both sides derive the session key:

```
session_key = HKDF-SHA256(
  ikm = shared_secret,
  salt = SHA256(
    client_public_key || gateway_public_key ||
    client_session_nonce || gateway_session_nonce
  ),
  info = "openclaw-relay-v1",
  length = 32
)
```

All subsequent messages are encrypted with this session key. Because both peers contribute a fresh session nonce, every reconnect derives a new key even when the long-term identity keys stay the same.

## Message Encryption

Each encrypted message is structured as:

```
nonce (12 bytes) || ciphertext || auth_tag (16 bytes)
```

Encoded as base64 for transmission in the Layer 0 DATA frame's `payload` field.

### Nonce Generation

Nonces are 12 bytes:
- Bytes 0-3: Direction prefix (`0x00000001` for client->gateway, `0x00000002` for gateway->client)
- Bytes 4-11: Monotonically increasing counter (big-endian uint64)

Each side maintains its own send counter, starting at 0. This ensures:
- No nonce reuse (counters never repeat)
- No collision between directions (different prefixes)

Counters reset to 0 only when a **new session key** has been derived.

### Encryption

```
plaintext = UTF-8 bytes of the Layer 2+ JSON message
(nonce, ciphertext, tag) = AES-256-GCM.encrypt(session_key, nonce, plaintext, aad="")
payload = base64(nonce || ciphertext || tag)
```

### Decryption

```
raw = base64_decode(payload)
nonce = raw[0:12]
ciphertext_and_tag = raw[12:]
plaintext = AES-256-GCM.decrypt(session_key, nonce, ciphertext_and_tag, aad="")
```

If decryption fails (bad key, tampered message, replay), the message MUST be silently dropped. Do not send error messages about decryption failures (information leakage).

## Anti-Replay

The receiver tracks the highest nonce counter seen from the peer. Any message with a counter <= the highest seen is rejected. A small window (64 messages) is allowed for out-of-order delivery.

## Key Rotation

For long-lived sessions, keys should be rotated periodically. Either side can initiate rotation by sending an encrypted KEY_ROTATE message:

```json
{
  "type": "key_rotate",
  "new_public_key": "<base64>"
}
```

The peer responds with its new public key. Both sides derive a new session key and reset their nonce counters.

Suggested rotation interval: every 24 hours or every 1 million messages, whichever comes first.

Key rotation limits future blast radius but does **not** provide full forward secrecy in v1 because long-lived identity keys are used during pairing.

## Revoking Access

To revoke a client's access:

```bash
openclaw relay revoke <client_id>
```

The gateway removes the client's public key from its approved list. Future HELLO attempts from that client are ignored.

## Security Properties

| Property | Guaranteed |
|----------|-----------|
| Confidentiality | Yes -- AES-256-GCM encryption |
| Integrity | Yes -- GCM authentication tag |
| Authenticity | Yes -- clients pin the gateway identity from pairing data; only holders of the shared secret can encrypt/decrypt |
| Forward secrecy | No -- not in v1. An Architecture Decision Record (ADR) should be created before v2 to evaluate adopting a Noise IK or XX handshake pattern for forward secrecy. |
| Replay protection | Yes -- monotonic nonce counters |
| Relay blindness | Yes -- relay only sees encrypted bytes and channel hash |
