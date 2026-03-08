import { describe, it, expect } from 'vitest';
import { RelayCrypto, buildNonce, checkReplay, b64Encode, b64Decode } from '../js/crypto.js';
import { concatBuffers } from '../js/utils.js';

// ---------------------------------------------------------------------------
// Helper: build a direction=2 (gateway→client) ciphertext using a session key
// ---------------------------------------------------------------------------
async function encryptAsGateway(sessionKey, plaintext, counter = 0) {
  const nonce = new Uint8Array(12);
  const dv = new DataView(nonce.buffer);
  dv.setUint32(0, 2); // direction: gateway -> client
  dv.setUint32(4, Math.floor(counter / 0x100000000));
  dv.setUint32(8, counter >>> 0);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    sessionKey,
    new TextEncoder().encode(plaintext)
  );

  return b64Encode(concatBuffers(nonce, new Uint8Array(ciphertext)));
}

// ===========================================================================
// RelayCrypto — real class tests
// ===========================================================================

describe('RelayCrypto.generateKeyPair', () => {
  it('produces a 32-byte public key', async () => {
    const rc = new RelayCrypto();
    await rc.generateKeyPair();
    expect(rc.publicKeyBytes).toBeInstanceOf(Uint8Array);
    expect(rc.publicKeyBytes.length).toBe(32);
  });

  it('produces a 32-byte clientNonce', async () => {
    const rc = new RelayCrypto();
    await rc.generateKeyPair();
    expect(rc.clientNonce).toBeInstanceOf(Uint8Array);
    expect(rc.clientNonce.length).toBe(32);
  });

  it('sets the keyPair property', async () => {
    const rc = new RelayCrypto();
    expect(rc.keyPair).toBeNull();
    await rc.generateKeyPair();
    expect(rc.keyPair).not.toBeNull();
    expect(rc.keyPair.publicKey).toBeDefined();
    expect(rc.keyPair.privateKey).toBeDefined();
  });

  it('generates distinct keys on each call', async () => {
    const a = new RelayCrypto();
    const b = new RelayCrypto();
    await a.generateKeyPair();
    await b.generateKeyPair();
    // Public keys from two independent generateKeyPair calls must differ
    const same = a.publicKeyBytes.every((v, i) => v === b.publicKeyBytes[i]);
    expect(same).toBe(false);
  });
});

describe('RelayCrypto identity persistence helpers', () => {
  it('exports and re-imports the same public identity', async () => {
    const original = new RelayCrypto();
    await original.generateKeyPair();
    const exported = await original.exportIdentity();

    const restored = new RelayCrypto();
    await restored.importIdentity(exported);

    expect(b64Encode(restored.publicKeyBytes)).toBe(exported.publicKey);
    expect(await restored.getPublicKeyFingerprint()).toBe(exported.fingerprint);
  });

  it('produces a sha256 fingerprint for the public key', async () => {
    const rc = new RelayCrypto();
    await rc.generateKeyPair();

    const fingerprint = await rc.getPublicKeyFingerprint();

    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('RelayCrypto.deriveSessionKey', () => {
  it('derives a session key and resets counters (two-sided)', async () => {
    const client = new RelayCrypto();
    const gateway = new RelayCrypto();
    await client.generateKeyPair();
    await gateway.generateKeyPair();

    await client.deriveSessionKey(gateway.publicKeyBytes, gateway.clientNonce);
    await gateway.deriveSessionKey(client.publicKeyBytes, client.clientNonce);

    expect(client.sessionKey).not.toBeNull();
    expect(gateway.sessionKey).not.toBeNull();
    expect(client.sendCounter).toBe(0);
    expect(client.recvCounterMax).toBe(-1);
    expect(client.recvWindow.size).toBe(0);
  });

  it('sessionKey can encrypt and decrypt (verifying key usages)', async () => {
    const client = new RelayCrypto();
    const gateway = new RelayCrypto();
    await client.generateKeyPair();
    await gateway.generateKeyPair();

    await client.deriveSessionKey(gateway.publicKeyBytes, gateway.clientNonce);

    // Verify the session key supports both encrypt and decrypt operations
    const nonce = new Uint8Array(12);
    const plaintext = new TextEncoder().encode('key usage test');
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      client.sessionKey,
      plaintext
    );
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      client.sessionKey,
      ct
    );
    expect(new TextDecoder().decode(pt)).toBe('key usage test');
  });
});

describe('RelayCrypto.encrypt', () => {
  /** Set up a client with a derived session key for encrypt tests */
  async function makeClient() {
    const client = new RelayCrypto();
    const gateway = new RelayCrypto();
    await client.generateKeyPair();
    await gateway.generateKeyPair();
    await client.deriveSessionKey(gateway.publicKeyBytes, gateway.clientNonce);
    return client;
  }

  it('returns a base64 string', async () => {
    const client = await makeClient();
    const result = await client.encrypt('hello');
    expect(typeof result).toBe('string');
    // Valid base64 should survive a round-trip
    const decoded = b64Decode(result);
    expect(b64Encode(decoded)).toBe(result);
  });

  it('ciphertext is at least 28 bytes (12 nonce + 16 GCM tag)', async () => {
    const client = await makeClient();
    const result = await client.encrypt('hello');
    const decoded = b64Decode(result);
    expect(decoded.length).toBeGreaterThanOrEqual(28);
  });

  it('ciphertext contains direction=1 nonce', async () => {
    const client = await makeClient();
    const result = await client.encrypt('test');
    const raw = b64Decode(result);
    const dv = new DataView(raw.buffer, raw.byteOffset, 12);
    expect(dv.getUint32(0)).toBe(1); // direction: client -> gateway
  });

  it('increments sendCounter on each call', async () => {
    const client = await makeClient();
    expect(client.sendCounter).toBe(0);
    await client.encrypt('a');
    expect(client.sendCounter).toBe(1);
    await client.encrypt('b');
    expect(client.sendCounter).toBe(2);
    await client.encrypt('c');
    expect(client.sendCounter).toBe(3);
  });

  it('each encrypted message has a unique counter in the nonce', async () => {
    const client = await makeClient();
    const counters = [];
    for (let i = 0; i < 5; i++) {
      const raw = b64Decode(await client.encrypt(`msg${i}`));
      const dv = new DataView(raw.buffer, raw.byteOffset, 12);
      const counter = dv.getUint32(4) * 0x100000000 + dv.getUint32(8);
      counters.push(counter);
    }
    // Counters should be 0, 1, 2, 3, 4
    expect(counters).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('RelayCrypto.decrypt', () => {
  /** Set up client + gateway, derive keys, return { client, gateway } */
  async function makePair() {
    const client = new RelayCrypto();
    const gateway = new RelayCrypto();
    await client.generateKeyPair();
    await gateway.generateKeyPair();
    await client.deriveSessionKey(gateway.publicKeyBytes, gateway.clientNonce);
    await gateway.deriveSessionKey(client.publicKeyBytes, client.clientNonce);
    return { client, gateway };
  }

  it('round-trip: decrypt a direction=2 ciphertext', async () => {
    const { client } = await makePair();
    // Manually build a gateway→client (direction=2) message
    const payload = await encryptAsGateway(client.sessionKey, 'hello from gateway');
    const result = await client.decrypt(payload);
    expect(result).toBe('hello from gateway');
  });

  it('decrypts multiple messages with incrementing counters', async () => {
    const { client } = await makePair();
    for (let i = 0; i < 5; i++) {
      const payload = await encryptAsGateway(client.sessionKey, `msg-${i}`, i);
      const result = await client.decrypt(payload);
      expect(result).toBe(`msg-${i}`);
    }
  });

  it('rejects direction=1 ciphertext (wrong direction)', async () => {
    const { client } = await makePair();
    // client.encrypt produces direction=1; client.decrypt expects direction=2
    const ciphertext = await client.encrypt('should be rejected');
    await expect(client.decrypt(ciphertext))
      .rejects.toThrow('Wrong nonce direction');
  });

  it('rejects replay (same payload twice)', async () => {
    const { client } = await makePair();
    const payload = await encryptAsGateway(client.sessionKey, 'once only', 0);
    // First decrypt succeeds
    await client.decrypt(payload);
    // Second decrypt must fail
    await expect(client.decrypt(payload))
      .rejects.toThrow('Replay detected');
  });

  it('rejects counter that is too old', async () => {
    const { client } = await makePair();
    await client.decrypt(await encryptAsGateway(client.sessionKey, 'zero', 0));
    // Advance recvCounterMax past the replay window by decrypting counter=100
    const advancePayload = await encryptAsGateway(client.sessionKey, 'advance', 100);
    await client.decrypt(advancePayload);
    // Now counter=1 is way behind (100 - 64 = 36, 1 <= 36 → too_old)
    const oldPayload = await encryptAsGateway(client.sessionKey, 'old', 1);
    await expect(client.decrypt(oldPayload))
      .rejects.toThrow('Replay detected: counter too old');
  });

  it('rejects ciphertext that is too short', async () => {
    const shortPayload = b64Encode(new Uint8Array(10)); // < 28 bytes
    const { client } = await makePair();
    await expect(client.decrypt(shortPayload))
      .rejects.toThrow('Ciphertext too short');
  });

  it('rejects tampered ciphertext (AES-GCM authentication)', async () => {
    const { client } = await makePair();
    const payload = await encryptAsGateway(client.sessionKey, 'authentic', 0);
    const raw = b64Decode(payload);
    // Flip a bit in the ciphertext portion (after the 12-byte nonce)
    raw[14] ^= 0xff;
    const tampered = b64Encode(raw);
    await expect(client.decrypt(tampered)).rejects.toThrow();
  });

  it('rejects a non-zero first inbound counter', async () => {
    const { client } = await makePair();
    const payload = await encryptAsGateway(client.sessionKey, 'bad-first', 1);
    await expect(client.decrypt(payload))
      .rejects.toThrow('Replay detected: first counter must be zero');
  });

  it('accepts out-of-order counters within the replay window after counter zero', async () => {
    const { client } = await makePair();
    await client.decrypt(await encryptAsGateway(client.sessionKey, 'zero', 0));
    const p5 = await encryptAsGateway(client.sessionKey, 'five', 5);
    const p3 = await encryptAsGateway(client.sessionKey, 'three', 3);
    await client.decrypt(p5);
    const result = await client.decrypt(p3);
    expect(result).toBe('three');
  });
});

// ===========================================================================
// buildNonce — helper function tests (preserved from original)
// ===========================================================================

describe('buildNonce', () => {
  it('encodes direction in first 4 bytes (big-endian)', () => {
    const nonce = buildNonce(1, 0);
    const dv = new DataView(nonce.buffer);
    expect(dv.getUint32(0)).toBe(1); // client->gateway

    const nonce2 = buildNonce(2, 0);
    const dv2 = new DataView(nonce2.buffer);
    expect(dv2.getUint32(0)).toBe(2); // gateway->client
  });

  it('encodes counter in bytes 4-11 (big-endian uint64)', () => {
    const nonce = buildNonce(1, 42);
    const dv = new DataView(nonce.buffer);
    const high = dv.getUint32(4);
    const low = dv.getUint32(8);
    expect(high * 0x100000000 + low).toBe(42);
  });

  it('returns a 12-byte Uint8Array', () => {
    const nonce = buildNonce(1, 0);
    expect(nonce).toBeInstanceOf(Uint8Array);
    expect(nonce.length).toBe(12);
  });

  it('handles large counters correctly', () => {
    // 2^32 = 4294967296 — should split across high and low
    const counter = 0x100000001; // 4294967297
    const nonce = buildNonce(1, counter);
    const dv = new DataView(nonce.buffer);
    expect(dv.getUint32(4)).toBe(1); // high word
    expect(dv.getUint32(8)).toBe(1); // low word
  });

  it('counter 0 produces all-zero counter bytes', () => {
    const nonce = buildNonce(2, 0);
    const dv = new DataView(nonce.buffer);
    expect(dv.getUint32(4)).toBe(0);
    expect(dv.getUint32(8)).toBe(0);
  });
});

// ===========================================================================
// checkReplay — helper function tests (preserved from original)
// ===========================================================================

describe('checkReplay', () => {
  it('accepts counter zero as the first inbound frame', () => {
    const window = new Set();
    expect(checkReplay(0, -1, window)).toBe('ok');
  });

  it('rejects a non-zero first inbound counter', () => {
    const window = new Set();
    expect(checkReplay(1, -1, window)).toBe('invalid_first_counter');
  });

  it('accepts sequential counters', () => {
    const window = new Set([0]);
    expect(checkReplay(1, 0, window)).toBe('ok');
    window.add(1);
    expect(checkReplay(2, 1, window)).toBe('ok');
  });

  it('rejects duplicate counters', () => {
    const window = new Set([0, 1, 2]);
    expect(checkReplay(1, 2, window)).toBe('duplicate');
  });

  it('rejects counters too far behind the window', () => {
    const window = new Set();
    // Window size is 64, so counter 0 is too old when max is 100
    expect(checkReplay(0, 100, window)).toBe('too_old');
    // Counter 36 is exactly at the cutoff (100 - 64 = 36), should be too_old
    expect(checkReplay(36, 100, window)).toBe('too_old');
  });

  it('accepts counter within the window that has not been seen', () => {
    const window = new Set([98, 99, 100]);
    // Counter 37 is within window (100 - 64 = 36, 37 > 36) and not in set
    expect(checkReplay(37, 100, window)).toBe('ok');
  });

  it('accepts a jump to a higher counter', () => {
    const window = new Set([0, 1, 2]);
    expect(checkReplay(1000, 2, window)).toBe('ok');
  });

  it('handles out-of-order within window', () => {
    const window = new Set([5, 7, 8, 10]);
    // Counter 6 was skipped, should be accepted (10 - 64 < 6)
    expect(checkReplay(6, 10, window)).toBe('ok');
    // Counter 9 was skipped, should be accepted
    expect(checkReplay(9, 10, window)).toBe('ok');
  });
});

// ===========================================================================
// nonce direction enforcement (preserved from original)
// ===========================================================================

describe('nonce direction enforcement', () => {
  it('client sends direction=1, receives direction=2', () => {
    // This validates the protocol contract
    const clientSend = buildNonce(1, 0);
    const gwSend = buildNonce(2, 0);

    const clientDv = new DataView(clientSend.buffer);
    const gwDv = new DataView(gwSend.buffer);

    expect(clientDv.getUint32(0)).toBe(1);
    expect(gwDv.getUint32(0)).toBe(2);

    // They must be different to prevent reflection attacks
    expect(clientDv.getUint32(0)).not.toBe(gwDv.getUint32(0));
  });
});
