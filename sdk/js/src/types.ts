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
  group?: string;
}

export interface AgentInfo extends Agent {
  tools: string[];
  recent_sessions: number;
}

export interface SessionsListParams {
  agent?: string;
  limit?: number;
  offset?: number;
}

export interface SessionSummary {
  id: string;
  agent: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
  preview: string;
}

export interface SessionsListResponse {
  sessions: SessionSummary[];
  total: number;
}

export interface SessionHistoryParams {
  session_id: string;
  limit?: number;
  before?: string | null;
}

export interface SessionMessage {
  role: string;
  content: string;
  timestamp: string;
}

export interface SessionHistoryResponse {
  messages: SessionMessage[];
  has_more: boolean;
}

export interface CronTask {
  id: string;
  name: string;
  agent: string;
  schedule: string;
  enabled: boolean;
  last_run: string;
  last_status: string;
}

export interface CronToggleResult {
  id: string;
  enabled: boolean;
}

export interface RelayClientOptions {
  relayUrl: string;
  channelToken: string;
  gatewayPublicKey: string;
  clientId?: string;
  identity?: RelayIdentity;
}
