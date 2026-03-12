export { RelayClient } from './client.js';
export { ChannelConnection, ChannelError, ChannelReconnected } from './channel.js';
export { TransportLayer, TransportError } from './transport.js';
export {
  DIRECTION_CLIENT_TO_GATEWAY,
  DIRECTION_GATEWAY_TO_CLIENT,
  IdentityKeyPair,
  SessionCipher,
  deriveSessionKey,
  generateSessionNonce,
  importAesKey,
  publicKeyFingerprint,
  type RelayIdentity,
} from './crypto.js';
export type { Agent, ChatChunk, ChatResponse, RelayClientOptions } from './types.js';
