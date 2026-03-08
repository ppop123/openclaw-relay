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
import { randomHex, generateMsgId } from './utils.js';

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

    // Frame waiters (populated during handshake)
    this._frameWaiters = new Map();
    this._dataWaiters = new Map();
  }

  async connect(relayUrl, channelToken, gatewayPubKeyB64) {
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
  }

  async _doConnect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.relayUrl);
      } catch (e) {
        this._setState('disconnected');
        reject(new Error('Invalid relay URL'));
        return;
      }

      const timeout = setTimeout(() => {
        this.ws.close();
        this._setState('disconnected');
        reject(new Error('Connection timeout'));
      }, 15000);

      this.ws.onopen = async () => {
        clearTimeout(timeout);
        try {
          await this._handshake();
          this._backoff = 1000;
          resolve();
        } catch (e) {
          this.ws.close();
          this._setState('disconnected');
          reject(e);
        }
      };

      this.ws.onerror = () => {
        clearTimeout(timeout);
        if (this.state === 'connecting' && !this._reconnecting) {
          this._setState('disconnected');
          reject(new Error('WebSocket connection failed'));
        }
      };

      this.ws.onclose = () => {
        clearTimeout(timeout);
        this.encrypted = false;
        // Reject all pending requests immediately
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('Connection lost'));
        }
        this.pendingRequests.clear();
        this.activeStreams.clear();
        if (!this._closed && this.state === 'connected') {
          this._setState('disconnected');
          this._scheduleReconnect();
        }
      };

      this.ws.onmessage = (event) => {
        this._handleFrame(JSON.parse(event.data));
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

    // Step 3: Generate ephemeral keypair and session nonce
    this.crypto = new RelayCrypto();
    await this.crypto.generateKeyPair();

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

    // Step 6: Verify gateway public key (TOFU)
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
      // Interrupt any handshake waiters
      for (const [, waiter] of this._frameWaiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(err);
      }
      this._frameWaiters.clear();
      for (const [, waiter] of this._dataWaiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(err);
      }
      this._dataWaiters.clear();
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(err);
      }
      this.pendingRequests.clear();
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

  // ── Connection management ──

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
    this.encrypted = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();
    this.activeStreams.clear();
    this._setState('disconnected');
  }
}
