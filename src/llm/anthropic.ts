import { sleep } from '../util/random.ts';
import { ManagedLiveClient } from './managed.ts';
import { LLMError, readError, unsupportedParam, type ChatMessage, type CompleteRequest } from './types.ts';

interface Options {
  apiKey: string;
  model: string;
  baseUrl?: string;
  params?: Record<string, unknown>;
}

export class AnthropicClient extends ManagedLiveClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly params: Record<string, unknown>;
  private dropped = new Set<string>();

  constructor(opts: Options) {
    super('anthropic', opts.model);
    this.url = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
    this.apiKey = opts.apiKey;
    this.params = opts.params ?? {};
  }

  protected async generate(req: CompleteRequest): Promise<string> {
    const body: Record<string, unknown> = {
      ...this.params,
      model: this.model,
      max_tokens: req.maxTokens ?? 1000,
      system: req.system + '\n\nRespond with a single JSON object only.',
      messages: normalise(req.messages),
    };
    for (const key of this.dropped) delete body[key];

    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        res = await this.request(this.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        });
      } catch (err) {
        if (attempt < 3) {
          await sleep(1500 * attempt);
          continue;
        }
        throw new LLMError(`network error: ${(err as Error).message}`, undefined, true);
      }

      if (res.ok) {
        const data = (await res.json()) as {
          content?: { type: string; text?: string }[];
          stop_reason?: string;
        };
        const text = (data.content ?? [])
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (!text) throw new LLMError(`empty completion (stop_reason=${data.stop_reason ?? 'unknown'})`, undefined, true);
        return text;
      }

      const message = await readError(res);

      if (res.status === 400) {
        const bad = unsupportedParam(message);
        if (bad && bad in body && !['model', 'messages', 'system', 'max_tokens'].includes(bad)) {
          delete body[bad];
          this.dropped.add(bad);
          if (attempt < 5) continue;
        }
        throw new LLMError(`400 ${message}`, 400);
      }

      if (res.status === 401 || res.status === 403) {
        throw new LLMError(`${res.status} ${message} — check the API key`, res.status);
      }

      if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 3) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new LLMError(`${res.status} ${message}`, res.status, res.status >= 429);
    }
  }
}

/** Anthropic requires alternating roles starting with "user". */
function normalise(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += '\n\n' + m.content;
    } else {
      out.push({ ...m });
    }
  }
  if (out.length === 0 || out[0]?.role !== 'user') {
    out.unshift({ role: 'user', content: '(continue)' });
  }
  return out;
}
