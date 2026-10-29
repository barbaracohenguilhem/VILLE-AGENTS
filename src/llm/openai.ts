import { sleep } from '../util/random.ts';
import { ManagedLiveClient } from './managed.ts';
import { LLMError, readError, unsupportedParam, type CompleteRequest } from './types.ts';

interface Options {
  provider: 'openai' | 'openai-compatible' | 'huggingface';
  baseUrl: string;
  apiKey: string;
  model: string;
  params?: Record<string, unknown>;
}

const REASONING_MODEL = /^(gpt-5|gpt-6|o\d)/i;

/**
 * Chat Completions client. Used for OpenAI itself and for any server speaking
 * the same protocol (Hugging Face Inference Providers, OpenRouter, Groq, Ollama,
 * LM Studio, vLLM, Azure AI Foundry…).
 */
export class OpenAICompatibleClient extends ManagedLiveClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly params: Record<string, unknown>;
  private readonly isOpenAI: boolean;
  private readonly jsonObjectFormat: boolean;
  private tokenField: 'max_tokens' | 'max_completion_tokens';
  private dropped = new Set<string>();

  constructor(opts: Options) {
    super(opts.provider, opts.model);
    this.isOpenAI = opts.provider === 'openai';
    this.jsonObjectFormat = opts.provider !== 'huggingface';
    this.tokenField = this.isOpenAI ? 'max_completion_tokens' : 'max_tokens';
    this.url = opts.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    this.apiKey = opts.apiKey;
    this.params = opts.params ?? this.defaultParams();
  }

  private defaultParams(): Record<string, unknown> {
    if (this.isOpenAI && REASONING_MODEL.test(this.model)) return { reasoning_effort: 'none' };
    return { temperature: 0.9 };
  }

  protected async generate(req: CompleteRequest): Promise<string> {
    const maxTokens = req.maxTokens ?? 700;
    const system = this.jsonObjectFormat
      ? req.system
      : `${req.system}\n\nRespond with a single JSON object only. No markdown.`;
    const body: Record<string, unknown> = {
      ...(this.jsonObjectFormat ? { response_format: { type: 'json_object' } } : {}),
      ...this.params,
      model: this.model,
      messages: [{ role: 'system', content: system }, ...req.messages],
    };
    // Reasoning models reject max_tokens; older compatible servers reject max_completion_tokens.
    delete body.max_tokens;
    delete body.max_completion_tokens;
    body[this.tokenField] = maxTokens;
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
            authorization: `Bearer ${this.apiKey}`,
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
          choices?: { message?: { content?: unknown }; finish_reason?: string }[];
        };
        const content = completionText(data.choices?.[0]?.message?.content);
        if (!content) {
          throw new LLMError(
            `empty completion (finish_reason=${data.choices?.[0]?.finish_reason ?? 'unknown'})`,
            undefined,
            true,
          );
        }
        return content;
      }

      const message = await readError(res);

      if (res.status === 400) {
        const bad = unsupportedParam(message);
        if (bad && bad in body && bad !== 'model' && bad !== 'messages') {
          // Swap token-limit field names, otherwise drop the offending parameter.
          if (bad === 'max_tokens' || bad === 'max_completion_tokens') {
            const replacement = bad === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
            if (this.dropped.has(replacement)) throw new LLMError('Both token-limit fields were rejected.', 400);
            this.tokenField = replacement;
            body[replacement] = maxTokens;
          }
          delete body[bad];
          this.dropped.add(bad);
          if (attempt < 5) continue;
        }
        throw new LLMError(`400 ${message}`, 400);
      }

      if (res.status === 401 || res.status === 403) {
        throw new LLMError(`${res.status} ${message} — check the API key`, res.status);
      }

      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new LLMError(`${res.status} ${message}`, res.status, res.status === 429 || res.status >= 500);
    }
  }
}

function completionText(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
    if (text.trim()) return text;
  }
  return undefined;
}
