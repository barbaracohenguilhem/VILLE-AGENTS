import type { ProviderKind } from '../types.ts';
import { ProviderUnavailableError, type CompleteRequest, type LLMClient } from './types.ts';

/** Preserve the requested identity without pretending a missing provider is a scripted mind. */
export class UnavailableClient implements LLMClient {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly label: string;
  readonly mode = 'unavailable' as const;
  readonly status = 'unavailable' as const;
  readonly online = false;
  readonly canComplete = false;
  readonly requests = 0;
  readonly note: string;

  constructor(provider: ProviderKind, model: string, reason: string) {
    this.provider = provider;
    this.model = model;
    this.label = `${provider} · ${model}`;
    this.note = reason;
  }

  async complete(_req: CompleteRequest): Promise<string> {
    throw new ProviderUnavailableError(this.note);
  }
}
