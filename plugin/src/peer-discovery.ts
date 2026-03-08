import { GatewayIdentity } from './crypto.js';
import {
  ConnectionState,
  DiscoverResultFrame,
  DiscoveryPeer,
  InviteCreatedFrame,
  PeerDiscoveryConfig,
  PeerSignalEnvelope,
  ReceivedPeerSignal,
  RelayFrame,
  SignalErrorFrame,
  SignalForwardFrame,
} from './types.js';
import { arrayBufferFrom, b64Decode, b64Encode, concatBuffers, randomToken, sha256Hex } from './utils.js';

const SIGNAL_INFO = new TextEncoder().encode('openclaw-relay-signal-v1');
const SIGNAL_IV_BYTES = 12;
const MIN_SIGNAL_PAYLOAD_BYTES = SIGNAL_IV_BYTES + 16;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function x25519Algorithm(): AlgorithmIdentifier {
  return { name: 'X25519' };
}

async function importPublicKey(publicKeyBase64: string): Promise<{ key: CryptoKey; bytes: Uint8Array }> {
  const bytes = b64Decode(publicKeyBase64);
  const key = await crypto.subtle.importKey('raw', arrayBufferFrom(bytes), x25519Algorithm(), true, []);
  return { key, bytes };
}

async function deriveSignalKey(privateKey: CryptoKey, ephemeralPublicKeyBytes: Uint8Array, targetPublicKeyBytes: Uint8Array): Promise<CryptoKey> {
  const publicKey = await crypto.subtle.importKey('raw', arrayBufferFrom(ephemeralPublicKeyBytes), x25519Algorithm(), true, []);
  const sharedSecret = await crypto.subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256);
  const salt = await crypto.subtle.digest('SHA-256', arrayBufferFrom(concatBuffers(ephemeralPublicKeyBytes, targetPublicKeyBytes)));
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: SIGNAL_INFO,
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function resolvePeerDiscoveryConfig(config: PeerDiscoveryConfig | undefined): PeerDiscoveryConfig {
  return {
    enabled: config?.enabled === true,
    ...(config?.metadata ? { metadata: structuredClone(config.metadata) as Record<string, unknown> } : {}),
  };
}

export function buildDiscoveryMetadata(capabilities: string[], configuredMetadata?: Record<string, unknown>): Record<string, unknown> {
  const uniqueCapabilities = [...new Set(capabilities)].sort();
  return {
    ...(configuredMetadata ? structuredClone(configuredMetadata) as Record<string, unknown> : {}),
    capabilities: uniqueCapabilities,
  };
}

export async function encryptPeerSignalEnvelope(
  targetPublicKeyBase64: string,
  envelope: PeerSignalEnvelope,
): Promise<{ ephemeralKey: string; payload: string }> {
  const target = await importPublicKey(targetPublicKeyBase64);
  const ephemeral = await crypto.subtle.generateKey(x25519Algorithm(), true, ['deriveBits']) as CryptoKeyPair;
  const ephemeralPublicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const signalKey = await deriveSignalKey(ephemeral.privateKey, ephemeralPublicKeyBytes, target.bytes);
  const iv = crypto.getRandomValues(new Uint8Array(SIGNAL_IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: arrayBufferFrom(iv) }, signalKey, plaintext);
  return {
    ephemeralKey: b64Encode(ephemeralPublicKeyBytes),
    payload: b64Encode(concatBuffers(iv, new Uint8Array(ciphertext))),
  };
}

export async function decryptPeerSignalEnvelope(identity: GatewayIdentity, frame: SignalForwardFrame): Promise<PeerSignalEnvelope> {
  const ephemeralPublicKeyBytes = b64Decode(frame.ephemeral_key);
  const signalKey = await deriveSignalKey(identity.privateKey, ephemeralPublicKeyBytes, identity.publicKeyBytes);
  const raw = b64Decode(frame.payload);
  if (raw.length < MIN_SIGNAL_PAYLOAD_BYTES) {
    throw new Error('signal payload too short');
  }
  const iv = raw.slice(0, SIGNAL_IV_BYTES);
  const ciphertext = raw.slice(SIGNAL_IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: arrayBufferFrom(iv) }, signalKey, arrayBufferFrom(ciphertext));
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  if (!isObject(parsed) || parsed.version !== 1 || typeof parsed.kind !== 'string') {
    throw new Error('invalid peer signal envelope');
  }
  if ('body' in parsed && parsed.body !== undefined && !isObject(parsed.body)) {
    throw new Error('peer signal body must be an object when present');
  }
  return parsed as PeerSignalEnvelope;
}

export async function createInviteAlias(byteLength = 24): Promise<{ inviteToken: string; inviteHash: string }> {
  const inviteToken = randomToken(byteLength);
  return {
    inviteToken,
    inviteHash: await sha256Hex(inviteToken),
  };
}

export interface PeerDiscoveryServiceOptions {
  identity: GatewayIdentity;
  discoveryConfig: () => PeerDiscoveryConfig | undefined;
  capabilities: () => string[];
  sendFrame: (frame: object) => Promise<void>;
}

export class PeerDiscoveryService {
  private readonly pendingSignals: ReceivedPeerSignal[] = [];
  private readonly pendingSignalErrors: SignalErrorFrame[] = [];
  private discoverWaiter:
    | {
        resolve: (peers: DiscoveryPeer[]) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private readonly inviteWaiters = new Map<string, {
    resolve: (frame: InviteCreatedFrame) => void;
    reject: (error: Error) => void;
  }>();

  constructor(private readonly options: PeerDiscoveryServiceOptions) {}

  get pendingSignalCount(): number {
    return this.pendingSignals.length;
  }

  get pendingSignalErrorCount(): number {
    return this.pendingSignalErrors.length;
  }

  getRegisterFields(): Record<string, unknown> {
    const config = resolvePeerDiscoveryConfig(this.options.discoveryConfig());
    if (!config.enabled) {
      return {};
    }
    return {
      discoverable: true,
      public_key: this.options.identity.serialized.publicKey,
      metadata: buildDiscoveryMetadata(this.options.capabilities(), config.metadata),
    };
  }

  async discoverPeers(): Promise<DiscoveryPeer[]> {
    if (this.discoverWaiter) {
      throw new Error('discover request already in flight');
    }
    return new Promise<DiscoveryPeer[]>(async (resolve, reject) => {
      this.discoverWaiter = { resolve, reject };
      try {
        await this.options.sendFrame({ type: 'discover' });
      } catch (error) {
        this.discoverWaiter = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async sendSignal(targetPublicKey: string, envelope: PeerSignalEnvelope): Promise<void> {
    if (!resolvePeerDiscoveryConfig(this.options.discoveryConfig()).enabled) {
      throw new Error('peer discovery is not enabled for this gateway');
    }
    const { ephemeralKey, payload } = await encryptPeerSignalEnvelope(targetPublicKey, envelope);
    await this.options.sendFrame({
      type: 'signal',
      target: targetPublicKey,
      ephemeral_key: ephemeralKey,
      payload,
    });
  }

  async createInvite(ttlSeconds = 300): Promise<{ inviteToken: string; inviteHash: string; expiresAt: string }> {
    if (!resolvePeerDiscoveryConfig(this.options.discoveryConfig()).enabled) {
      throw new Error('peer discovery is not enabled for this gateway');
    }
    const { inviteToken, inviteHash } = await createInviteAlias();
    const created = await this.createInviteHash(inviteHash, ttlSeconds);
    return {
      inviteToken,
      inviteHash,
      expiresAt: created.expires_at,
    };
  }

  async createInviteHash(inviteHash: string, ttlSeconds = 300): Promise<InviteCreatedFrame> {
    return new Promise<InviteCreatedFrame>(async (resolve, reject) => {
      this.inviteWaiters.set(inviteHash, { resolve, reject });
      try {
        await this.options.sendFrame({
          type: 'invite_create',
          invite_hash: inviteHash,
          max_uses: 1,
          ttl_seconds: ttlSeconds,
        });
      } catch (error) {
        this.inviteWaiters.delete(inviteHash);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async handleFrame(frame: RelayFrame): Promise<boolean> {
    if (frame.type === 'discover_result' && Array.isArray((frame as DiscoverResultFrame).peers)) {
      const waiter = this.discoverWaiter;
      this.discoverWaiter = undefined;
      waiter?.resolve((frame as DiscoverResultFrame).peers);
      return true;
    }

    if (frame.type === 'invite_created' && typeof (frame as InviteCreatedFrame).invite_hash === 'string' && typeof (frame as InviteCreatedFrame).expires_at === 'string') {
      const created = frame as InviteCreatedFrame;
      const waiter = this.inviteWaiters.get(created.invite_hash);
      if (waiter) {
        this.inviteWaiters.delete(created.invite_hash);
        waiter.resolve(created);
      }
      return true;
    }

    if (frame.type === 'signal_error' && typeof (frame as SignalErrorFrame).code === 'string') {
      this.pendingSignalErrors.push(frame as SignalErrorFrame);
      return true;
    }

    if (frame.type === 'signal' && typeof (frame as SignalForwardFrame).source === 'string' && typeof (frame as SignalForwardFrame).ephemeral_key === 'string' && typeof (frame as SignalForwardFrame).payload === 'string') {
      try {
        const signal = frame as SignalForwardFrame;
        const envelope = await decryptPeerSignalEnvelope(this.options.identity, signal);
        this.pendingSignals.push({
          source: signal.source,
          envelope,
          receivedAt: new Date().toISOString(),
          raw: signal,
        });
      } catch {
        // Malformed or undecryptable peer signal is dropped.
      }
      return true;
    }

    return false;
  }

  handleConnectionState(state: ConnectionState): void {
    if (state === 'registered') return;
    const error = new Error('peer discovery is unavailable while relay connection is not registered');
    if (this.discoverWaiter) {
      const waiter = this.discoverWaiter;
      this.discoverWaiter = undefined;
      waiter.reject(error);
    }
    for (const [inviteHash, waiter] of this.inviteWaiters.entries()) {
      this.inviteWaiters.delete(inviteHash);
      waiter.reject(error);
    }
  }

  drainSignals(): ReceivedPeerSignal[] {
    return this.pendingSignals.splice(0, this.pendingSignals.length);
  }

  drainSignalErrors(): SignalErrorFrame[] {
    return this.pendingSignalErrors.splice(0, this.pendingSignalErrors.length);
  }
}
