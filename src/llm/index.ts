import type { LLMStats, ResidentConfig } from '../types.ts';
import { env } from '../util/env.ts';
import { Semaphore } from '../util/random.ts';
import { AnthropicClient } from './anthropic.ts';
import { OfflineClient } from './offline.ts';
import { OpenAICompatibleClient } from './openai.ts';
import { ProviderUnavailableError, type CompleteRequest, type LLMClient, type ProviderMode, type ProviderStatus } from './types.ts';
import { UnavailableClient } from './unavailable.ts';

export type { CompleteRequest, LLMClient, OfflineMeta, ProviderMode, ProviderStatus } from './types.ts';
export { LLMError, ProviderUnavailableError } from './types.ts';

export const HF_ROUTER_URL = 'https://router.huggingface.co/v1';
export const HF_DEFAULT_MODEL = 'Qwen/Qwen2.5-7B-Instruct:fastest';

const DEFAULT_MODEL: Record<string, string> = {
  openai: 'gpt-6-luna',
  anthropic: 'claude-haiku-5-5',
  'openai-compatible': 'llama3.2',
  huggingface: HF_DEFAULT_MODEL,
};

export interface CallRecord {
  who: string;
  provider: string;
  model: string;
  ms: number;
  ok: boolean;
  error?: string;
  mode: ProviderMode;
  status: ProviderStatus;
  online: boolean;
  requests: number;
  note?: string;
  retryAt?: number;
  skipped?: boolean;
}

export const stats: LLMStats = { calls: 0, requests: 0, errors: 0, totalMs: 0, demoCalls: 0, skipped: 0 };

/** Caps how many residents may be waiting on a model at once. */
const gate = new Semaphore(3);

export function setConcurrency(n: number): void {
  gate.max = Math.max(1, Math.floor(n) || 1);
}

/** Missing live configuration stays unavailable; scripted behavior requires explicit offline mode. */
export function createClient(cfg: ResidentConfig, onCall?: (rec: CallRecord) => void): LLMClient {
  const raw = buildRaw(cfg);
  return instrument(raw, cfg.name, onCall);
}

function buildRaw(cfg: ResidentConfig): LLMClient {
  const model = cfg.model ?? DEFAULT_MODEL[cfg.provider] ?? 'unknown';
  switch (cfg.provider) {
    case 'openai': {
      const key = env(cfg.apiKeyEnv ?? 'OPENAI_API_KEY');
      if (!key) return new UnavailableClient(cfg.provider, model, 'Missing OpenAI credentials. Configure the provider to enable it.');
      return new OpenAICompatibleClient({
        provider: 'openai',
        baseUrl: cfg.baseUrl ?? env('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
        apiKey: key,
        model,
        params: cfg.params,
      });
    }
    case 'anthropic': {
      const key = env(cfg.apiKeyEnv ?? 'ANTHROPIC_API_KEY');
      if (!key) return new UnavailableClient(cfg.provider, model, 'Missing Anthropic credentials. Configure the provider to enable it.');
      return new AnthropicClient({ apiKey: key, model, baseUrl: cfg.baseUrl ?? env('ANTHROPIC_BASE_URL'), params: cfg.params });
    }
    case 'openai-compatible': {
      const baseUrl = cfg.baseUrl ?? env('OPENAI_COMPAT_BASE_URL');
      if (!baseUrl) return new UnavailableClient(cfg.provider, model, 'Missing compatible-provider configuration. Configure the provider to enable it.');
      const key = env(cfg.apiKeyEnv ?? 'OPENAI_COMPAT_API_KEY') ?? 'none';
      return new OpenAICompatibleClient({
        provider: 'openai-compatible',
        baseUrl,
        apiKey: key,
        model,
        params: cfg.params,
      });
    }
    case 'huggingface': {
      const key = env(cfg.apiKeyEnv ?? 'HF_TOKEN') ?? env('HUGGINGFACE_API_KEY');
      if (!key) return new UnavailableClient(cfg.provider, model, 'Missing Hugging Face credentials. Set HF_TOKEN to enable Inference Providers.');
      return new OpenAICompatibleClient({
        provider: 'huggingface',
        baseUrl: cfg.baseUrl ?? env('HF_BASE_URL') ?? HF_ROUTER_URL,
        apiKey: key,
        model,
        params: cfg.params,
      });
    }
    case 'offline':
      return new OfflineClient('Scripted demo explicitly enabled. No model is connected.');
    default:
      return new UnavailableClient(cfg.provider, model, 'Unknown provider configuration.');
  }
}

function instrument(client: LLMClient, who: string, onCall?: (rec: CallRecord) => void): LLMClient {
  return {
    get provider() {
      return client.provider;
    },
    get model() {
      return client.model;
    },
    get label() {
      return client.label;
    },
    get mode() {
      return client.mode;
    },
    get status() {
      return client.status;
    },
    get online() {
      return client.online;
    },
    get note() {
      return client.note;
    },
    get canComplete() {
      return client.canComplete;
    },
    get retryAt() {
      return client.retryAt;
    },
    get requests() {
      return client.requests;
    },
    async complete(req: CompleteRequest): Promise<string> {
      return gate.run(async () => {
        const started = Date.now();
        const before = client.requests;
        const record = (ok: boolean, error?: unknown): void => {
          const ms = Date.now() - started;
          const requests = client.requests - before;
          const skipped = error instanceof ProviderUnavailableError;
          stats.requests += requests;
          if (skipped) stats.skipped++;
          else if (client.mode === 'demo') stats.demoCalls++;
          else if (client.mode === 'live') {
            stats.calls++;
            stats.totalMs += ms;
            if (!ok) stats.errors++;
          }
          onCall?.({
            who, provider: client.provider, model: client.model, ms, ok,
            mode: client.mode, status: client.status, online: client.online,
            requests, note: client.note, retryAt: client.retryAt,
            ...(skipped ? { skipped: true } : {}),
            ...(!ok ? { error: client.note ?? 'Provider request was not completed.' } : {}),
          });
        };
        let out: string;
        try {
          out = await client.complete(req);
        } catch (err) {
          record(false, err);
          throw err;
        }
        record(true);
        return out;
      });
    },
  };
}
