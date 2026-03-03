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
  safety_action?: 'pass' | 'clarify' | 'degrade' | 'refuse';
  reason_code?: string;
  retryable?: boolean;
  clarify_round?: number;
  channel: Channel;
  latencyMs: number;
  policyVersion?: string;
  policySource?: string;
  sourceLabel?: string | null;
  trustLevel?: string | null;
  computer_use_job_id?: string | null;
  computer_use_status?: string | null;
  computer_use_transport?: 'mcp_stdio' | 'http_agent' | 'hybrid' | string | null;
  computer_use_provider?: 'openai_byok' | 'chatgpt_plus_relay_poc' | 'unknown' | string | null;
}

export interface SchoolBotResponse {
  reply: string;
  persona?: 'alice' | 'professional' | string;
  meta?: SchoolBotMeta;
  auto_escape?: boolean;
}

export type SchoolBotEngineMode = 'legacy' | 'v2' | 'shadow';
export type SchoolBotEngineTarget = 'legacy' | 'v2';

export interface SchoolBotEngineRequest {
  requestId: string;
  userId: string;
  channel: Channel;
  mode: SchoolBotEngineMode;
  percent: number;
}

export interface SchoolBotEngineResponse {
  mode: SchoolBotEngineMode;
  primary: SchoolBotEngineTarget;
  shadow: SchoolBotEngineTarget | null;
  percent: number;
  bucket: number;
  sampledToV2: boolean;
}

export interface IngressAuthResult {
  ok: boolean;
  status?: number;
  reason?: string;
  mode?: 'disabled' | 'shared_key' | 'signature';
  message?: string;
}

export interface SafetyDecisionMeta {
  action: 'pass' | 'clarify' | 'degrade' | 'refuse';
  reason_code: string;
  category: string;
  confidence: number;
  source: string;
  retryable: boolean;
  clarify_round: number;
  hard_block: boolean;
}

export interface RefusalPolicyResult extends SafetyDecisionMeta {
  clarify_required: boolean;
}

export interface ClarifyState {
  requestId: string;
  userId: string;
  clarify_round: number;
  last_reason_code: string;
  updated_at: string;
}
