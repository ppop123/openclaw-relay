import { describe, expect, it } from 'vitest';
import { DIRECTION_CLIENT_TO_GATEWAY, DIRECTION_GATEWAY_TO_CLIENT, SessionCipher, importAesKey } from '../src/crypto.js';
import { randomBytes } from '../src/utils.js';

describe('SessionCipher', () => {
  it('encrypts and decrypts across directions', async () => {
    const key = await importAesKey(randomBytes(32));
    const clientCipher = new SessionCipher(key, DIRECTION_CLIENT_TO_GATEWAY);
    const gatewayCipher = new SessionCipher(key, DIRECTION_GATEWAY_TO_CLIENT);

    const plaintext = new TextEncoder().encode('hello');
    const encrypted = await clientCipher.encrypt(plaintext);
    const decrypted = await gatewayCipher.decrypt(encrypted);

    expect(new TextDecoder().decode(decrypted)).toBe('hello');
  });

  it('rejects replayed counters', async () => {
    const key = await importAesKey(randomBytes(32));
    const clientCipher = new SessionCipher(key, DIRECTION_CLIENT_TO_GATEWAY);
    const gatewayCipher = new SessionCipher(key, DIRECTION_GATEWAY_TO_CLIENT);

    const plaintext = new TextEncoder().encode('hi');
    const encrypted = await clientCipher.encrypt(plaintext);
    await gatewayCipher.decrypt(encrypted);

    await expect(gatewayCipher.decrypt(encrypted)).rejects.toThrow(/Replay detected/);
  });
});
