import type { RelayIdentity } from './crypto.js';

export interface ChatChunk {
  delta: string;
  session_id: string;
}

export interface ChatResponse {
  content: string;
  session_id: string;
  agent: string;
  tokens: Record<string, unknown>;
}

export interface Agent {
  name: string;
  display_name: string;
  status: string;
  description: string;
}

export interface RelayClientOptions {
  relayUrl: string;
  channelToken: string;
  gatewayPublicKey: string;
  clientId?: string;
  identity?: RelayIdentity;
}
