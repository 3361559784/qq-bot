export type Channel = 'web' | 'qq' | 'unknown';

export interface RequestState {
  requestId: string;
  senderId: string;
  dbKey: string;
  channel: Channel;
  message: string;
}

export interface SchoolBotMeta {
  requestId: string;
  tool: string | null;
  intent: string | null;
  channel: Channel;
  latencyMs: number;
  policyVersion?: string;
  policySource?: string;
  sourceLabel?: string | null;
  trustLevel?: string | null;
}

export interface SchoolBotResponse {
  reply: string;
  persona?: 'alice' | 'professional' | string;
  meta?: SchoolBotMeta;
  auto_escape?: boolean;
}
