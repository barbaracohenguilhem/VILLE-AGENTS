import type { ProviderKind } from '../types.ts';
import { LLMError, ProviderUnavailableError, type CompleteRequest, type LLMClient, type ProviderStatus } from './types.ts';

const INITIAL_COOLDOWN_MS = 15_000;
const MAX_COOLDOWN_MS = 5 * 60_000;

/** Admission and health state shared by real providers; transport retries stay in the provider. */
export abstract class ManagedLiveClient implements LLMClient {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly label: string;
  readonly mode = 'live' as const;
  status: ProviderStatus = 'unverified';
  online = false;
  note?: string;
  retryAt?: number;
  requests = 0;

  private inFlight = false;
  private failures = 0;

  constructor(provider: ProviderKind, model: string) {
    this.provider = provider;
    this.model = model;
    this.label = `${provider} · ${model}`;
  }

  get canComplete(): boolean {
    return !this.inFlight && this.status !== 'unavailable' && (this.retryAt === undefined || Date.now() >= this.retryAt);
  }

  async complete(req: CompleteRequest): Promise<string> {
    if (!this.canComplete) {
      throw new ProviderUnavailableError(
        this.inFlight ? 'A provider request is already in progress.' : this.note ?? 'Provider is unavailable.',
        this.retryAt,
      );
    }
    this.inFlight = true;
    try {
      const result = await this.generate(req);
      this.online = true;
      this.status = 'ready';
      this.note = undefined;
      this.retryAt = undefined;
      this.failures = 0;
      return result;
    } catch (err) {
      this.online = false;
      this.failures++;
      const permanent = err instanceof LLMError && !err.retryable;
      this.note = safeFailureNote(err);
      if (permanent) {
        this.status = 'unavailable';
        this.retryAt = undefined;
      } else {
        this.status = 'cooldown';
        this.retryAt = Date.now() + Math.min(MAX_COOLDOWN_MS, INITIAL_COOLDOWN_MS * 2 ** Math.min(this.failures - 1, 10));
      }
      // Provider messages may contain arbitrary server content. Keep credentials and endpoints out of UI/log errors.
      throw new LLMError(this.note, err instanceof LLMError ? err.status : undefined, !permanent);
    } finally {
      this.inFlight = false;
    }
  }

  protected async request(url: string, init: RequestInit): Promise<Response> {
    this.requests++;
    try {
      const response = await fetch(url, init);
      if (!response.ok) this.online = false;
      return response;
    } catch (err) {
      this.online = false;
      throw err;
    }
  }

  protected abstract generate(req: CompleteRequest): Promise<string>;
}

function safeFailureNote(err: unknown): string {
  const status = err instanceof LLMError ? err.status : undefined;
  if (status === 401 || status === 403) return `Provider authentication failed (HTTP ${status}). Update its configuration to retry.`;
  if (status === 400 || status === 404 || status === 422) return `Provider configuration was rejected (HTTP ${status}). Update its configuration to retry.`;
  if (status === 429) return 'Provider rate limit reached. Waiting before retrying.';
  if (status !== undefined) return `Provider request failed (HTTP ${status}).`;
  return 'Provider did not return a usable response. Waiting before retrying.';
}
