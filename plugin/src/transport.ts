import { deriveGatewaySession, GatewayIdentity, SessionCipher } from './crypto.js';
import {
  ApprovedClientRecord,
  CancelMessage,
  ClientSessionRecord,
  DataFrame,
  HelloAckMessage,
  HelloMessage,
  Layer2Message,
  RelayAccountConfig,
  RequestMessage,
  ResponseMessage,
} from './types.js';
import { b64Decode, b64Encode, nowIso, publicKeyFingerprint, utf8ByteLength } from './utils.js';

export interface GatewaySession extends ClientSessionRecord {
  cipher: SessionCipher;
}

const MAX_LAYER2_PLAINTEXT_BYTES = 512 * 1024;

export interface GatewayTransportOptions {
  accountId: string;
  identity: GatewayIdentity;
  accountConfig: () => RelayAccountConfig;
  pairingActive: () => boolean;
  endPairing: () => void;
  capabilities: () => string[];
  sendFrame: (frame: DataFrame) => Promise<void> | void;
  approveUnknownClient?: (publicKeyB64: string, clientId: string) => Promise<string | undefined>;
  authorizePeerClient?: (publicKeyB64: string, clientId: string, fingerprint: string) => Promise<boolean>;
  touchApprovedClient?: (fingerprint: string, clientId: string) => Promise<void>;
  onRequest: (session: GatewaySession, message: RequestMessage) => Promise<void> | void;
  onCancel?: (session: GatewaySession, message: CancelMessage) => Promise<void> | void;
  onNotify?: (session: GatewaySession, message: Extract<Layer2Message, { type: 'notify' }>) => Promise<void> | void;
  onSessionEnded?: (session: GatewaySession, reason: string) => Promise<void> | void;
}

export class GatewayTransport {
  private readonly sessionsByClientId = new Map<string, GatewaySession>();
  private readonly activeClientIdByFingerprint = new Map<string, string>();
  private readonly negotiatedCapabilitiesByClientId = new Map<string, string[]>();
  private pairingClaimed = false;

  constructor(private readonly options: GatewayTransportOptions) {}

  get sessionCount(): number {
    return this.sessionsByClientId.size;
  }

  getSession(clientId: string): GatewaySession | undefined {
    return this.sessionsByClientId.get(clientId);
  }

  async handleDataFrame(frame: DataFrame): Promise<void> {
    const clientId = frame.from;
    if (!clientId) return;

    const session = this.sessionsByClientId.get(clientId);
    if (!session) {
      await this.processHello(clientId, frame.payload);
      return;
    }

    const plaintext = await session.cipher.decryptToText(frame.payload);
    if (utf8ByteLength(plaintext) > MAX_LAYER2_PLAINTEXT_BYTES) {
      return;
    }
    const message = JSON.parse(plaintext) as Layer2Message;
    session.lastActivity = new Date();
    await this.dispatchLayer2(session, message);
  }

  async sendLayer2(clientId: string, message: Layer2Message): Promise<void> {
    const session = this.sessionsByClientId.get(clientId);
    if (!session) {
      throw new Error(`no active session for client '${clientId}'`);
    }

    const payload = await session.cipher.encryptJson(message as Record<string, unknown>);
    await this.options.sendFrame({
      type: 'data',
      from: 'gateway',
      to: clientId,
      payload,
    });
  }

  async endSessionByClientId(clientId: string, reason: string): Promise<void> {
    const session = this.sessionsByClientId.get(clientId);
    if (!session) return;
    this.sessionsByClientId.delete(clientId);
    const mapped = this.activeClientIdByFingerprint.get(session.fingerprint);
    if (mapped === clientId) {
      this.activeClientIdByFingerprint.delete(session.fingerprint);
    }
    this.negotiatedCapabilitiesByClientId.delete(clientId);
    await this.options.onSessionEnded?.(session, reason);
  }

  async endSessionsByFingerprint(fingerprint: string, reason: string): Promise<void> {
    const clientId = this.activeClientIdByFingerprint.get(fingerprint);
    if (clientId) {
      await this.endSessionByClientId(clientId, reason);
    }
  }

  async handlePresenceOffline(clientId: string): Promise<void> {
    await this.endSessionByClientId(clientId, 'presence_offline');
  }

  negotiatedCapabilities(clientId: string): string[] {
    return this.negotiatedCapabilitiesByClientId.get(clientId) ?? [];
  }

  private findApprovedClientByClientId(clientId: string): [string, ApprovedClientRecord] | undefined {
    const approved = this.options.accountConfig().approvedClients;
    return Object.entries(approved).find(([, record]) => record.lastSeenClientId === clientId);
  }

  private tryClaimPairingWindow(): boolean {
    if (!this.options.pairingActive() || this.pairingClaimed) {
      return false;
    }
    this.pairingClaimed = true;
    return true;
  }

  private releasePairingWindow(): void {
    this.pairingClaimed = false;
  }

  private async processHello(clientId: string, payload: string): Promise<void> {
    let hello: HelloMessage;
    try {
      hello = JSON.parse(payload) as HelloMessage;
    } catch {
      await this.sendHelloReject(clientId, 'invalid_frame', 'Invalid hello payload');
      return;
    }
    if (hello.type !== 'hello') {
      return;
    }
    const protocolVersion = hello.protocol_version ?? 0;
    if (protocolVersion > 1) {
      await this.sendHelloReject(clientId, 'unsupported_protocol', 'Client protocol version is not supported');
      return;
    }

    const clientPublicKeyBytes = b64Decode(hello.client_public_key);
    if (clientPublicKeyBytes.length !== 32) {
      await this.sendHelloReject(clientId, 'invalid_client_key', 'Client public key is invalid');
      return;
    }
    const clientNonce = b64Decode(hello.session_nonce);
    if (clientNonce.length !== 32) {
      await this.sendHelloReject(clientId, 'invalid_nonce', 'Client session nonce is invalid');
      return;
    }

    const fingerprint = await publicKeyFingerprint(clientPublicKeyBytes);
    const approvedClients = this.options.accountConfig().approvedClients;
    let approved = approvedClients[fingerprint];
    let peerAuthorized = false;
    const previouslySeen = this.findApprovedClientByClientId(clientId);

    if (previouslySeen && previouslySeen[0] !== fingerprint && !this.options.pairingActive()) {
      await this.sendHelloReject(
        clientId,
        'pairing_required',
        'This client identity changed. Ask OpenClaw for a new pairing link and open it within the pairing window.',
      );
      return;
    }

    if (!approved) {
      peerAuthorized = await this.options.authorizePeerClient?.(hello.client_public_key, clientId, fingerprint) === true;
      if (!peerAuthorized) {
        if (!this.tryClaimPairingWindow()) {
          await this.sendHelloReject(
            clientId,
            'pairing_required',
            'Pairing is required. Ask OpenClaw for a new pairing link and open it within the pairing window.',
          );
          return;
        }
        try {
          let savedFingerprint: string | undefined;
          try {
            savedFingerprint = await this.options.approveUnknownClient?.(hello.client_public_key, clientId);
          } catch {
            await this.sendHelloReject(clientId, 'pairing_failed', 'Pairing failed. Please try again.');
            return;
          }
          if (!savedFingerprint) {
            await this.sendHelloReject(clientId, 'pairing_rejected', 'Pairing was not approved.');
            return;
          }
          this.options.endPairing();
          approved = this.options.accountConfig().approvedClients[savedFingerprint];
          if (!approved) {
            await this.sendHelloReject(clientId, 'pairing_failed', 'Pairing succeeded but could not be loaded. Please try again.');
            return;
          }
        } finally {
          this.releasePairingWindow();
        }
      }
    }

    if (approved) {
      await this.options.touchApprovedClient?.(fingerprint, clientId);
    }

    const existingClientId = this.activeClientIdByFingerprint.get(fingerprint);
    if (existingClientId && existingClientId !== clientId) {
      await this.endSessionByClientId(existingClientId, 'replaced_by_new_session');
    }

    const { gatewayNonce, cipher } = await deriveGatewaySession(this.options.identity, clientPublicKeyBytes, clientNonce);
    const session: GatewaySession = {
      clientId,
      fingerprint,
      publicKey: clientPublicKeyBytes,
      capabilities: hello.capabilities ?? [],
      connectedAt: new Date(),
      lastActivity: new Date(),
      cipher,
    };
    this.sessionsByClientId.set(clientId, session);
    this.activeClientIdByFingerprint.set(fingerprint, clientId);
    this.negotiatedCapabilitiesByClientId.set(clientId, hello.capabilities ?? []);

    const ack: HelloAckMessage = {
      type: 'hello_ack',
      gateway_public_key: b64Encode(this.options.identity.publicKeyBytes),
      session_nonce: b64Encode(gatewayNonce),
      protocol_version: 1,
      capabilities: this.options.capabilities(),
    };

    try {
      await this.options.sendFrame({
        type: 'data',
        from: 'gateway',
        to: clientId,
        payload: JSON.stringify(ack),
      });
    } catch {
      await this.endSessionByClientId(clientId, 'send_failed');
    }
  }

  private async sendHelloReject(clientId: string, code: string, message: string): Promise<void> {
    try {
      await this.options.sendFrame({
        type: 'data',
        from: 'gateway',
        to: clientId,
        payload: JSON.stringify({ type: 'hello_reject', code, message }),
      });
    } catch {
      // Ignore - the client will time out.
    }
  }

  private async dispatchLayer2(session: GatewaySession, message: Layer2Message): Promise<void> {
    switch (message.type) {
      case 'request':
        await this.options.onRequest(session, message as RequestMessage);
        return;
      case 'cancel':
        await this.options.onCancel?.(session, message as CancelMessage);
        return;
      case 'notify':
        await this.options.onNotify?.(session, message as Extract<Layer2Message, { type: 'notify' }>);
        return;
      default:
        return;
    }
  }
}
