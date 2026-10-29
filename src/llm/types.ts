import type { ProviderKind } from '../types.ts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type CallKind = 'action' | 'reply' | 'plan' | 'reflection';
export type ProviderMode = 'live' | 'demo' | 'unavailable';
export type ProviderStatus = 'unverified' | 'ready' | 'cooldown' | 'unavailable' | 'demo';

export interface CompleteRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Hint used by the offline brain to fabricate a plausible answer. */
  kind: CallKind;
  meta?: OfflineMeta;
}

export interface OfflineMeta {
  name: string;
  room: string;
  others: string[];
  rooms: string[];
  objects: string[];
  partner?: string;
  turn?: number;
}

export interface LLMClient {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly label: string;
  readonly mode: ProviderMode;
  readonly status: ProviderStatus;
  /** True only after an observed successful provider response. */
  readonly online: boolean;
  readonly note?: string;
  readonly canComplete: boolean;
  readonly retryAt?: number;
  /** Actual HTTP attempts, including transport retries. Scripted clients keep this at zero. */
  readonly requests: number;
  complete(req: CompleteRequest): Promise<string>;
}

/** A local admission rejection: no model request was made. */
export class ProviderUnavailableError extends Error {
  readonly skipped = true;
  readonly retryAt?: number;

  constructor(message: string, retryAt?: number) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.retryAt = retryAt;
  }
}

export class LLMError extends Error {
  status: number | undefined;
  retryable: boolean;
  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.retryable = retryable;
  }
}

export async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const msg = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message);
    if (msg) return msg;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300) || res.statusText;
}

/**
 * If a 400 error names an unsupported body parameter, return that parameter
 * so the caller can drop it and retry. Handles the common phrasings from
 * OpenAI, Anthropic and OpenAI-compatible servers.
 */
export function unsupportedParam(message: string): string | undefined {
  const patterns = [
    /unsupported (?:parameter|value)[^'"]*['"]([a-z_.]+)['"]/i,
    /['"]([a-z_.]+)['"] (?:is|are) not supported/i,
    /['"]([a-z_.]+)['"]: extra (?:inputs|fields)/i,
    /unrecognized request argument[^'"]*['"]?([a-z_.]+)['"]?/i,
    /([a-z_]+) is not (?:allowed|supported) (?:with|for|when)/i,
    /unknown parameter:?\s*['"]?([a-z_.]+)/i,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m?.[1]) return m[1].split('.')[0];
  }
  return undefined;
}
