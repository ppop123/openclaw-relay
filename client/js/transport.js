/**
 * Layer 0+1+2: Relay connection, handshake, request/response, streaming.
 *
 * This module handles WebSocket connection to the relay, the E2E
 * encryption handshake, and the request/response protocol on top.
 *
 * UI notifications are delivered via callbacks (onToast, onStateChange,
 * onNotify) — this module does not import any UI code.
 */

import { b64Encode, b64Decode, RelayCrypto } from './crypto.js';
import { deleteStoredIdentity, loadStoredIdentity, saveStoredIdentity, supportsPersistentIdentity } from './identity-store.js';
import { randomHex, generateMsgId } from './utils.js';

const EXPORTED_IDENTITY_FORMAT = 'openclaw-relay-browser-identity';
const EXPORTED_IDENTITY_VERSION = 1;

export class RelayConnection {
  constructor() {
    this.ws = null;
    this.crypto = new RelayCrypto();
    this.state = 'disconnected'; // disconnected | connecting | connected
    this.relayUrl = '';
    this.channelHash = '';
    this.clientId = '';
    this.gatewayPubKeyB64 = '';
    this.channelToken = '';
    this.encrypted = false;
    this.identityPersistence = supportsPersistentIdentity() ? 'absent' : 'unsupported';
    this.identityFingerprint = '';
    this.identityCreatedAt = '';
    this._storedIdentityRecord = null;
    this._identityLoadFailed = false;

    // Pending request handlers: id -> { resolve, reject, onChunk, timeout }
    this.pendingRequests = new Map();
    // Active streams: id -> { onChunk, buffer }
    this.activeStreams = new Map();

    // Callbacks (set by the application layer)
    this.onStateChange = null;
    this.onNotify = null;
    this.onToast = null; // (message, type) => void

    // Reconnection
    this._backoff = 1000;
    this._maxBackoff = 60000;
    this._reconnecting = false;
    this._closed = false;
    this._connectPromise = null;

    // Frame waiters (populated during handshake)
    this._frameWaiters = new Map();
    this._dataWaiters = new Map();
  }

  async connect(relayUrl, channelToken, gatewayPubKeyB64) {
    if (this._connectPromise || this.state === 'connecting') {
      throw new Error('Connection already in progress');
    }
    if (this.state === 'connected' && this.ws) {
      throw new Error('Already connected');
    }

    const attempt = (async () => {
      this.relayUrl = relayUrl;
      this.channelToken = channelToken;
      this.gatewayPubKeyB64 = gatewayPubKeyB64;
      this._closed = false;

      // Hash the channel token with SHA-256
      const tokenBytes = new TextEncoder().encode(channelToken);
      const hashBuf = await crypto.subtle.digest('SHA-256', tokenBytes);
      this.channelHash = Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0')).join('');

      // Use persistent client ID (survives page reloads and reconnections)
      if (!this.clientId) {
        this.clientId = localStorage.getItem('openclaw-relay-client-id');
        if (!this.clientId) {
          this.clientId = 'web_' + randomHex(8);
          localStorage.setItem('openclaw-relay-client-id', this.clientId);
        }
      }

      this._setState('connecting');
      await this._doConnect();
    })();

    this._connectPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this._connectPromise === attempt) {
        this._connectPromise = null;
      }
    }
  }

  getIdentitySummary() {
    const exists = Boolean(this.crypto.keyPair) || Boolean(this._storedIdentityRecord);
    const publicKey = this._storedIdentityRecord?.publicKey
      || (this.crypto.publicKeyBytes ? b64Encode(this.crypto.publicKeyBytes) : '');
    return {
      exists,
      canReset: exists,
      canExport: exists,
      canImport: true,
      loaded: Boolean(this.crypto.keyPair),
      persistence: this.identityPersistence,
      persisted: this.identityPersistence === 'persisted',
      fingerprint: this.identityFingerprint,
      publicKey,
      createdAt: this.identityCreatedAt || null,
      loadFailed: this._identityLoadFailed,
    };
  }

  async hydratePersistedIdentity() {
    if (this.crypto.keyPair) {
      await this._refreshIdentityMetadata();
      return this.getIdentitySummary();
    }

    if (!supportsPersistentIdentity()) {
      this.identityPersistence = 'unsupported';
      return this.getIdentitySummary();
    }

    let storedIdentity = null;
    try {
      storedIdentity = await loadStoredIdentity();
      this._identityLoadFailed = false;
    } catch (err) {
      console.warn('Failed to load persisted browser identity:', err);
      this.onToast?.('Failed to load persisted browser identity; a new one will be created on connect.', 'warning');
      this._storedIdentityRecord = null;
      this._identityLoadFailed = true;
      this.identityPersistence = 'absent';
      return this.getIdentitySummary();
    }

    if (!storedIdentity) {
      this._storedIdentityRecord = null;
      this.identityPersistence = 'absent';
      return this.getIdentitySummary();
    }

    this._storedIdentityRecord = storedIdentity;
    this.identityPersistence = 'persisted';
    this.identityCreatedAt = storedIdentity.createdAt || '';
    this.identityFingerprint = storedIdentity.fingerprint || '';
    return this.getIdentitySummary();
  }

  async resetIdentity() {
    this.disconnect();
    this.crypto.clearIdentity();
    this.identityPersistence = supportsPersistentIdentity() ? 'absent' : 'unsupported';
    this.identityFingerprint = '';
    this.identityCreatedAt = '';
    this._storedIdentityRecord = null;
    this._identityLoadFailed = false;
    try {
      await deleteStoredIdentity();
    } catch (err) {
      console.warn('Failed to delete stored identity:', err);
      throw new Error('Failed to reset browser identity');
    }
    return this.getIdentitySummary();
  }

  async exportIdentityBundle() {
    let identity = null;

    if (this._storedIdentityRecord) {
      identity = { ...this._storedIdentityRecord };
    } else if (this.crypto.keyPair) {
      identity = {
        algorithm: 'X25519',
        ...(await this.crypto.exportIdentity()),
        createdAt: this.identityCreatedAt || new Date().toISOString(),
      };
    }

    if (!identity) {
      throw new Error('No browser identity is available to export');
    }

    return {
      format: EXPORTED_IDENTITY_FORMAT,
      version: EXPORTED_IDENTITY_VERSION,
      algorithm: identity.algorithm || 'X25519',
      publicKey: identity.publicKey,
      privateKeyPkcs8: identity.privateKeyPkcs8,
      fingerprint: identity.fingerprint || this.identityFingerprint,
      createdAt: identity.createdAt || this.identityCreatedAt || new Date().toISOString(),
      exportedAt: new Date().toISOString(),
    };
  }

  async importIdentityBundle(bundle) {
    const candidate = this._extractPortableIdentity(bundle);
    const validator = new RelayCrypto();
    await validator.importIdentity(candidate);
    const fingerprint = await validator.getPublicKeyFingerprint();

    if (candidate.fingerprint && candidate.fingerprint !== fingerprint) {
      throw new Error('Identity fingerprint does not match the supplied keypair');
    }

    const normalized = {
      publicKey: candidate.publicKey,
      privateKeyPkcs8: candidate.privateKeyPkcs8,
      fingerprint,
      createdAt: candidate.createdAt || new Date().toISOString(),
    };

    this.disconnect();
    this._identityLoadFailed = false;

    if (!supportsPersistentIdentity()) {
      await this.crypto.importIdentity(normalized);
      this._storedIdentityRecord = null;
      this.identityPersistence = 'memory';
      this.identityFingerprint = fingerprint;
      this.identityCreatedAt = normalized.createdAt;
      return this.getIdentitySummary();
    }

    try {
      const stored = await saveStoredIdentity(normalized);
      this.crypto.clearIdentity();
      this._storedIdentityRecord = stored;
      this.identityPersistence = 'persisted';
      this.identityFingerprint = stored.fingerprint || fingerprint;
      this.identityCreatedAt = stored.createdAt || normalized.createdAt;
      return this.getIdentitySummary();
    } catch (err) {
      console.warn('Failed to persist imported browser identity:', err);
      await this.crypto.importIdentity(normalized);
      this._storedIdentityRecord = null;
      this.identityPersistence = 'memory';
      this.identityFingerprint = fingerprint;
      this.identityCreatedAt = normalized.createdAt;
      this.onToast?.('Imported identity is active for this page only because persistence is unavailable.', 'warning');
      return this.getIdentitySummary();
    }
  }

  _extractPortableIdentity(bundle) {
    if (!bundle || typeof bundle !== 'object') {
      throw new Error('Identity file must contain an object');
    }

    if (bundle.format && bundle.format !== EXPORTED_IDENTITY_FORMAT) {
      throw new Error('Unsupported identity file format');
    }

    const candidate = bundle.identity && typeof bundle.identity === 'object'
      ? bundle.identity
      : bundle;

    if (candidate.algorithm && candidate.algorithm !== 'X25519') {
      throw new Error('Only X25519 identities are supported');
    }
    if (typeof candidate.publicKey !== 'string' || !candidate.publicKey) {
      throw new Error('Identity file missing publicKey');
    }
    if (typeof candidate.privateKeyPkcs8 !== 'string' || !candidate.privateKeyPkcs8) {
      throw new Error('Identity file missing privateKeyPkcs8');
    }

    const version = bundle.version ?? candidate.version ?? EXPORTED_IDENTITY_VERSION;
    if (version > EXPORTED_IDENTITY_VERSION) {
      throw new Error('Identity file version is newer than this client supports');
    }

    return {
      publicKey: candidate.publicKey,
      privateKeyPkcs8: candidate.privateKeyPkcs8,
      fingerprint: typeof candidate.fingerprint === 'string' ? candidate.fingerprint : '',
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
    };
  }

  async _doConnect() {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(this.relayUrl);
        this.ws = socket;
      } catch (e) {
        this._setState('disconnected');
        reject(new Error('Invalid relay URL'));
        return;
      }

      const timeout = setTimeout(() => {
        if (this.ws !== socket) return;
        try {
          socket.close();
        } catch {}
        this._setState('disconnected');
        reject(new Error('Connection timeout'));
      }, 15000);

      socket.onopen = async () => {
        if (this.ws !== socket) return;
        clearTimeout(timeout);
        try {
          await this._handshake();
          this._backoff = 1000;
          resolve();
        } catch (e) {
          try {
            socket.close();
          } catch {}
          this._setState('disconnected');
          reject(e);
        }
      };

      socket.onerror = () => {
        if (this.ws !== socket) return;
        clearTimeout(timeout);
        if (this.state === 'connecting' && !this._reconnecting) {
          this._setState('disconnected');
          reject(new Error('WebSocket connection failed'));
        }
      };

      socket.onclose = () => {
        if (this.ws !== socket) return;
        clearTimeout(timeout);
        this._handleSocketClose(new Error('Connection lost'));
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        void this._handleSocketMessage(event);
      };
    });
  }

  async _handshake() {
    // Step 1: Send JOIN frame
    this._sendRaw({
      type: 'join',
      channel: this.channelHash,
      version: 1,
      client_id: this.clientId
    });

    // Step 2: Wait for JOINED
    const joined = await this._waitForFrame('joined', 10000);
    if (!joined.gateway_online) {
      throw new Error('Gateway is offline. Please ensure the gateway is running.');
    }

    // Step 3: Ensure identity keypair exists; always generate fresh session nonce.
    // The keypair is long-lived for this browser identity and reused across reconnects.
    // Session uniqueness comes from the fresh nonce mixed into HKDF salt.
    await this._ensureClientIdentity();

    // Step 4: Send HELLO via DATA frame (unencrypted)
    const helloPayload = JSON.stringify({
      type: 'hello',
      client_public_key: b64Encode(this.crypto.publicKeyBytes),
      session_nonce: b64Encode(this.crypto.clientNonce),
      protocol_version: 1,
      capabilities: ['chat', 'stream']
    });

    this._sendRaw({
      type: 'data',
      to: 'gateway',
      payload: helloPayload
    });

    // Step 5: Wait for HELLO_ACK (arrives as DATA frame with unencrypted payload)
    const helloAck = await this._waitForDataPayload('hello_ack', 10000);

    // Step 6: Verify gateway public key against the user-supplied pinned key
    const receivedGwPubKey = helloAck.gateway_public_key;
    if (receivedGwPubKey !== this.gatewayPubKeyB64) {
      throw new Error(
        'SECURITY WARNING: Gateway public key does not match!\n' +
        'Expected: ' + this.gatewayPubKeyB64.substring(0, 16) + '...\n' +
        'Received: ' + receivedGwPubKey.substring(0, 16) + '...\n' +
        'Connection refused. This could indicate a MITM attack.'
      );
    }

    // Step 7: Derive session key
    const gwPubKeyBytes = b64Decode(receivedGwPubKey);
    const gwNonce = b64Decode(helloAck.session_nonce);
    await this.crypto.deriveSessionKey(gwPubKeyBytes, gwNonce);

    this.encrypted = true;
    this._setState('connected');
  }

  _sendRaw(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  async sendEncrypted(message) {
    const payload = await this.crypto.encrypt(JSON.stringify(message));
    this._sendRaw({
      type: 'data',
      to: 'gateway',
      payload: payload
    });
  }

  // ── Request/Response ──

  async sendRequest(method, params) {
    const id = generateMsgId();
    const msg = { id, type: 'request', method, params };

    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 120000);

      this.pendingRequests.set(id, { resolve, reject, timeout: timer });
      try {
        await this.sendEncrypted(msg);
      } catch (e) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(e);
      }
    });
  }

  async sendStreamRequest(method, params, onChunk) {
    const id = generateMsgId();
    const msg = { id, type: 'request', method, params };

    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        this.activeStreams.delete(id);
        reject(new Error(`Stream timeout: ${method}`));
      }, 300000); // 5 min for streaming

      this.pendingRequests.set(id, { resolve, reject, timeout: timer, streaming: true });
      this.activeStreams.set(id, { onChunk, buffer: '' });
      try {
        await this.sendEncrypted(msg);
      } catch (e) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        this.activeStreams.delete(id);
        reject(e);
      }
    });
  }

  // ── Frame handling ──

  _waitForFrame(type, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._frameWaiters.delete(type);
        reject(new Error(`Timeout waiting for ${type} frame`));
      }, timeoutMs);

      this._frameWaiters.set(type, { resolve, reject, timeout: timer });
    });
  }

  _waitForDataPayload(type, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._dataWaiters.delete(type);
        reject(new Error(`Timeout waiting for ${type} payload`));
      }, timeoutMs);

      this._dataWaiters.set(type, { resolve, reject, timeout: timer });
    });
  }

  async _handleFrame(frame) {
    const type = frame.type;

    // Layer 0 frame types
    if (type === 'joined' || type === 'registered' || type === 'presence') {
      if (this._frameWaiters.has(type)) {
        const waiter = this._frameWaiters.get(type);
        this._frameWaiters.delete(type);
        clearTimeout(waiter.timeout);
        waiter.resolve(frame);
        return;
      }
      if (type === 'presence') {
        if (frame.role === 'gateway') {
          if (frame.status === 'offline') {
            this.onToast?.('Gateway went offline', 'warning');
          } else if (frame.status === 'online') {
            this.onToast?.('Gateway is back online', 'info');
          }
        }
      }
      return;
    }

    if (type === 'pong') return;

    if (type === 'ping') {
      this._sendRaw({ type: 'pong', ts: frame.ts });
      return;
    }

    if (type === 'error') {
      console.error('Relay error:', frame.message);
      this.onToast?.(frame.message || 'Relay error', 'error');
      const err = new Error(`Relay error: ${frame.code || 'unknown'}`);
      this._rejectHandshakeWaiters(err);
      this._rejectPendingRequests(err);
      this.activeStreams.clear();
      return;
    }

    if (type === 'data') {
      await this._handleDataFrame(frame);
    }
  }

  async _handleDataFrame(frame) {
    let payload;

    // If we have a session key, all data frames MUST be encrypted.
    // Never fall back to plaintext — doing so would let the relay
    // inject unencrypted messages and break E2E integrity.
    if (this.encrypted && this.crypto.sessionKey) {
      try {
        const plaintext = await this.crypto.decrypt(frame.payload);
        payload = JSON.parse(plaintext);
      } catch (e) {
        console.error('Failed to decrypt data frame (dropping):', e);
        return;
      }
    } else {
      // During handshake, messages are unencrypted
      try {
        payload = JSON.parse(frame.payload);
      } catch {
        console.error('Failed to parse data frame payload');
        return;
      }
    }

    // Check if this is a HELLO_ACK for the handshake
    if (payload.type === 'hello_ack' && this._dataWaiters.has('hello_ack')) {
      const waiter = this._dataWaiters.get('hello_ack');
      this._dataWaiters.delete('hello_ack');
      clearTimeout(waiter.timeout);
      waiter.resolve(payload);
      return;
    }

    // Layer 2 message types
    this._handleL2Message(payload);
  }

  _handleL2Message(msg) {
    const id = msg.id;
    const type = msg.type;

    if (type === 'response') {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || msg.error.code));
        } else {
          if (pending.streaming) {
            this.activeStreams.delete(id);
          }
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (type === 'stream_start') {
      return;
    }

    if (type === 'stream_chunk') {
      const stream = this.activeStreams.get(id);
      if (stream && stream.onChunk) {
        stream.onChunk(msg.data);
      }
      return;
    }

    if (type === 'stream_end') {
      // Wait for the final RESPONSE that follows stream_end
      return;
    }

    if (type === 'notify') {
      if (this.onNotify) {
        this.onNotify(msg.event, msg.data);
      }
      return;
    }
  }

  async _handleSocketMessage(event) {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch (error) {
      console.error('Malformed relay frame:', error);
      this.onToast?.('Received malformed frame from relay', 'error');
      this._handleProtocolFailure(new Error('Received malformed frame from relay'));
      return;
    }

    try {
      await this._handleFrame(frame);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Failed to process relay frame');
      console.error('Failed to process relay frame:', err);
      this.onToast?.(err.message, 'error');
      this._handleProtocolFailure(err);
    }
  }

  _handleProtocolFailure(error) {
    this.encrypted = false;
    this.crypto.clearSession();
    this._rejectHandshakeWaiters(error);
    this._rejectPendingRequests(error);
    this.activeStreams.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    } else if (this.state !== 'disconnected') {
      this._setState('disconnected');
    }
  }

  _handleSocketClose(error) {
    this.encrypted = false;
    this.crypto.clearSession();
    this._rejectHandshakeWaiters(error);
    this._rejectPendingRequests(error);
    this.activeStreams.clear();
    if (!this._closed && this.state === 'connected') {
      this._setState('disconnected');
      this._scheduleReconnect();
      return;
    }
    if (this.state !== 'disconnected') {
      this._setState('disconnected');
    }
  }

  _rejectHandshakeWaiters(error) {
    for (const [, waiter] of this._frameWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this._frameWaiters.clear();

    for (const [, waiter] of this._dataWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this._dataWaiters.clear();
  }

  _rejectPendingRequests(error) {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  _clearChannelRuntimeSecrets() {
    this.channelToken = '';
    this.channelHash = '';
  }

  // ── Connection management ──

  async _ensureClientIdentity() {
    if (this.crypto.keyPair) {
      this.crypto.regenerateNonce();
      await this._refreshIdentityMetadata();
      return this.getIdentitySummary();
    }

    if (this._storedIdentityRecord) {
      try {
        await this.crypto.importIdentity(this._storedIdentityRecord);
        this.crypto.regenerateNonce();
        await this._refreshIdentityMetadata();
        return this.getIdentitySummary();
      } catch (err) {
        console.warn('Stored browser identity is invalid; clearing it:', err);
        let deleted = false;
        try {
          await deleteStoredIdentity();
          deleted = true;
        } catch (deleteErr) {
          console.warn('Failed to clear invalid stored identity:', deleteErr);
        }
        this.onToast?.('Stored browser identity was invalid and will be replaced for this session.', 'warning');
        this.crypto.clearIdentity();
        this._identityLoadFailed = true;
        if (deleted) {
          this._storedIdentityRecord = null;
          this.identityPersistence = 'absent';
          this.identityFingerprint = '';
          this.identityCreatedAt = '';
        }
      }
    }

    await this.crypto.generateKeyPair();
    this.identityPersistence = 'memory';
    await this._refreshIdentityMetadata();

    if (!supportsPersistentIdentity() || this._identityLoadFailed) {
      return this.getIdentitySummary();
    }

    try {
      const stored = await saveStoredIdentity({
        ...(await this.crypto.exportIdentity()),
        createdAt: this.identityCreatedAt || new Date().toISOString(),
      });
      this.identityPersistence = 'persisted';
      this.identityCreatedAt = stored.createdAt || this.identityCreatedAt;
      this.identityFingerprint = stored.fingerprint || this.identityFingerprint;
    } catch (err) {
      console.warn('Failed to persist browser identity:', err);
      this.identityPersistence = 'memory';
      this.onToast?.('Browser identity could not be persisted; this page will appear as a new client after reload.', 'warning');
    }

    return this.getIdentitySummary();
  }

  async _refreshIdentityMetadata() {
    if (!this.crypto.keyPair) {
      if (this._storedIdentityRecord) {
        this.identityPersistence = 'persisted';
        this.identityFingerprint = this._storedIdentityRecord.fingerprint || '';
        this.identityCreatedAt = this._storedIdentityRecord.createdAt || '';
        return this.getIdentitySummary();
      }
      this.identityFingerprint = '';
      this.identityCreatedAt = '';
      this.identityPersistence = supportsPersistentIdentity() ? 'absent' : 'unsupported';
      return this.getIdentitySummary();
    }

    this.identityFingerprint = await this.crypto.getPublicKeyFingerprint();
    if (!this.identityCreatedAt) {
      this.identityCreatedAt = new Date().toISOString();
    }
    return this.getIdentitySummary();
  }

  _setState(state) {
    this.state = state;
    if (this.onStateChange) this.onStateChange(state);
  }

  async _scheduleReconnect() {
    if (this._closed || this._reconnecting) return;
    this._reconnecting = true;

    while (!this._closed) {
      const jitter = Math.random() * 0.25 * this._backoff;
      const delay = this._backoff + jitter;
      this.onToast?.(`Reconnecting in ${(delay / 1000).toFixed(1)}s...`, 'warning');
      this._setState('connecting');

      await new Promise(r => setTimeout(r, delay));
      if (this._closed) break;

      try {
        await this._doConnect();
        this.onToast?.('Reconnected', 'info');
        this._reconnecting = false;
        return;
      } catch (e) {
        console.warn('Reconnect failed:', e.message);
        this._backoff = Math.min(this._backoff * 2, this._maxBackoff);
      }
    }

    this._reconnecting = false;
  }

  disconnect() {
    this._closed = true;
    this._connectPromise = null;
    this.encrypted = false;
    this.crypto.clearSession();
    const error = new Error('Disconnected');
    this._rejectHandshakeWaiters(error);
    this._rejectPendingRequests(error);
    this.activeStreams.clear();
    this._clearChannelRuntimeSecrets();
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try {
        socket.close();
      } catch {}
    }
    this._setState('disconnected');
  }
}
