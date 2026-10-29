import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { ResidentConfig } from '../src/types.ts';
import { AnthropicClient } from '../src/llm/anthropic.ts';
import { createClient, HF_ROUTER_URL, stats, type CallRecord } from '../src/llm/index.ts';
import { ManagedLiveClient } from '../src/llm/managed.ts';
import { OpenAICompatibleClient } from '../src/llm/openai.ts';
import { LLMError, ProviderUnavailableError, type CompleteRequest } from '../src/llm/types.ts';

const req: CompleteRequest = { system: 'Test only.', messages: [{ role: 'user', content: 'Test.' }], kind: 'action' };
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
const config = (provider: ResidentConfig['provider']): ResidentConfig => ({
  name: 'Test resident', emoji: 'T', color: '#000000', provider, model: 'test-model',
  apiKeyEnv: 'VILLE_PROVIDER_TEST_KEY_NOT_CONFIGURED', bio: '', traits: [], goals: [], homeRoom: 'test',
});

beforeEach((t) => {
  Object.assign(stats, { calls: 0, requests: 0, errors: 0, totalMs: 0, demoCalls: 0, skipped: 0 });
  // Every test blocks real fetches; individual tests replace this with an in-memory response.
  if (!('mock' in t)) throw new Error('Provider checks require an individual test context.');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Real network is disabled in provider tests.'); });
});

test('missing live credentials preserve configured identity and never fabricate a completion', async () => {
  const events: CallRecord[] = [];
  for (const provider of ['openai', 'anthropic', 'huggingface'] as const) {
    const client = createClient(config(provider), (event) => events.push(event));
    assert.equal(client.provider, provider);
    assert.equal(client.model, 'test-model');
    assert.equal(client.mode, 'unavailable');
    assert.equal(client.status, 'unavailable');
    assert.equal(client.online, false);
    assert.equal(client.canComplete, false);
    await assert.rejects(client.complete(req), ProviderUnavailableError);
  }
  assert.equal(stats.calls, 0);
  assert.equal(stats.requests, 0);
  assert.equal(stats.demoCalls, 0);
  assert.equal(stats.errors, 0);
  assert.equal(stats.skipped, 3);
  assert.ok(events.every((event) => event.skipped && event.requests === 0 && event.mode === 'unavailable'));
});

test('huggingface routes through Inference Providers and stays unavailable without a token', async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    urls.push(String(input));
    return success();
  });
  const missing = createClient(config('huggingface'));
  assert.equal(missing.provider, 'huggingface');
  assert.equal(missing.mode, 'unavailable');
  await assert.rejects(missing.complete(req), ProviderUnavailableError);

  process.env.VILLE_HF_TEST_KEY = 'hf_test_token';
  const client = createClient({ ...config('huggingface'), apiKeyEnv: 'VILLE_HF_TEST_KEY' });
  assert.equal(client.mode, 'live');
  assert.equal(await client.complete(req), '{"ok":true}');
  assert.equal(urls[0], `${HF_ROUTER_URL}/chat/completions`);
  delete process.env.VILLE_HF_TEST_KEY;
});

test('missing compatible endpoint remains unavailable instead of silently entering demo mode', async () => {
  const client = createClient({ ...config('openai-compatible'), baseUrl: '' });
  assert.equal(client.provider, 'openai-compatible');
  assert.equal(client.model, 'test-model');
  assert.equal(client.mode, 'unavailable');
  await assert.rejects(client.complete(req), ProviderUnavailableError);
  assert.equal(stats.requests, 0);
});

test('explicit offline mode is counted only as a scripted demo', async () => {
  const client = createClient(config('offline'));
  assert.equal(client.mode, 'demo');
  assert.equal(client.status, 'demo');
  assert.equal(client.online, false);
  assert.equal(client.canComplete, true);
  assert.ok(JSON.parse(await client.complete(req)).action);
  assert.equal(stats.demoCalls, 1);
  assert.equal(stats.calls, 0);
  assert.equal(stats.requests, 0);
});

test('live health is unverified until a successful model response, with separate wire counts', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => success());
  const events: CallRecord[] = [];
  const client = createClient({ ...config('openai-compatible'), baseUrl: 'http://provider.invalid/v1' }, (event) => events.push(event));
  assert.equal(client.mode, 'live');
  assert.equal(client.status, 'unverified');
  assert.equal(client.online, false);
  assert.equal(client.canComplete, true);
  assert.equal(await client.complete(req), '{"ok":true}');
  assert.equal(client.online, true);
  assert.equal(client.status, 'ready');
  assert.equal(client.requests, 1);
  assert.equal(stats.calls, 1);
  assert.equal(stats.requests, 1);
  assert.equal(stats.demoCalls, 0);
  assert.equal(events[0]?.online, true);
  assert.equal(events[0]?.requests, 1);
});

class ProbeClient extends ManagedLiveClient {
  attempts = 0;
  result: () => Promise<string> = async () => '{"ok":true}';
  constructor() { super('openai-compatible', 'test-model'); }
  protected async generate(): Promise<string> { this.attempts++; return this.result(); }
}

test('failure makes health offline, blocks cooldown calls and recovers on the next successful probe', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const client = new ProbeClient();
  await client.complete(req);
  assert.equal(client.online, true);
  client.result = async () => { throw new LLMError('secret upstream content', 503, true); };
  await assert.rejects(client.complete(req), /HTTP 503/);
  assert.equal(client.online, false);
  assert.equal(client.status, 'cooldown');
  assert.equal(client.retryAt, now + 15_000);
  assert.equal(client.canComplete, false);
  assert.ok(!client.note?.includes('secret'));
  const before = client.attempts;
  await assert.rejects(client.complete(req), ProviderUnavailableError);
  assert.equal(client.attempts, before);
  now = client.retryAt!;
  assert.equal(client.canComplete, true);
  client.result = async () => '{"recovered":true}';
  await client.complete(req);
  assert.equal(client.status, 'ready');
  assert.equal(client.online, true);
  assert.equal(client.note, undefined);
  assert.equal(client.retryAt, undefined);
  client.result = async () => { throw new LLMError('failed again', 503, true); };
  await assert.rejects(client.complete(req));
  assert.equal(client.retryAt, now + 15_000, 'success resets exponential backoff');
});

test('repeated failed probes use bounded exponential cooldown capped at five minutes', async (t) => {
  let now = 5_000;
  t.mock.method(Date, 'now', () => now);
  const client = new ProbeClient();
  client.result = async () => { throw new LLMError('unreachable', undefined, true); };
  const delays: number[] = [];
  for (let i = 0; i < 10; i++) {
    await assert.rejects(client.complete(req));
    delays.push(client.retryAt! - now);
    assert.equal(client.canComplete, false);
    now = client.retryAt!;
  }
  assert.deepEqual(delays, [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000, 300_000]);
});

test('only one recovery probe may run at a time', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const client = new ProbeClient();
  client.result = async () => { throw new LLMError('unreachable', undefined, true); };
  await assert.rejects(client.complete(req));
  now = client.retryAt!;
  let release!: (value: string) => void;
  client.result = () => new Promise((resolve) => { release = resolve; });
  const pending = client.complete(req);
  assert.equal(client.canComplete, false);
  await assert.rejects(client.complete(req), ProviderUnavailableError);
  release('{"ok":true}');
  await pending;
  assert.equal(client.online, true);
  assert.equal(client.attempts, 2);
});

test('authentication rejection stays unavailable without repeated requests and omits upstream secrets', async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++;
    return new Response(JSON.stringify({ error: { message: 'secret-token at http://private.invalid' } }), { status: 401 });
  });
  const client = new AnthropicClient({ apiKey: 'test-secret', model: 'test-model' });
  await assert.rejects(client.complete(req), (err: unknown) => {
    assert.match(String(err), /authentication failed/);
    assert.doesNotMatch(String(err), /secret-token|private\.invalid|test-secret/);
    return true;
  });
  assert.equal(client.status, 'unavailable');
  assert.equal(client.online, false);
  assert.equal(client.retryAt, undefined);
  await assert.rejects(client.complete(req), ProviderUnavailableError);
  assert.equal(fetches, 1);
});

test('network retries are finite, subsequent completions are blocked, and real attempts are counted', async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new TypeError('fetch failed with sensitive endpoint'); });
  const events: CallRecord[] = [];
  const client = createClient({ ...config('openai-compatible'), baseUrl: 'http://provider.invalid/v1' }, (event) => events.push(event));
  await assert.rejects(client.complete(req), /Provider did not return a usable response/);
  assert.equal(fetches, 3);
  assert.equal(client.status, 'cooldown');
  assert.equal(client.online, false);
  await assert.rejects(client.complete(req), ProviderUnavailableError);
  assert.equal(fetches, 3);
  assert.equal(stats.calls, 1);
  assert.equal(stats.requests, 3);
  assert.equal(stats.errors, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(events[0]?.requests, 3);
  assert.equal(events[1]?.requests, 0);
  assert.ok(events.every((event) => !event.error?.includes('sensitive endpoint')));
});

test('unsupported request parameters have a finite retry budget', async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    fetches++;
    const body = JSON.parse(String(init.body));
    const param = ['temperature', 'response_format', 'seed', 'top_p', 'max_tokens'].find((key) => key in body) ?? 'model';
    return new Response(JSON.stringify({ error: { message: `Unsupported parameter: '${param}'` } }), { status: 400 });
  });
  const client = new OpenAICompatibleClient({ provider: 'openai-compatible', apiKey: 'test', baseUrl: 'http://provider.invalid/v1', model: 'test', params: { temperature: 1, seed: 1, top_p: 1 } });
  await assert.rejects(client.complete(req), /HTTP 400/);
  assert.equal(fetches, 5);
  assert.equal(client.status, 'unavailable');
  await assert.rejects(client.complete(req), ProviderUnavailableError);
  assert.equal(fetches, 5);
});

test('negotiated token limits persist and extra params cannot override the displayed model or messages', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (bodies.length === 1) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'" } }), { status: 400 });
    return success();
  });
  const client = new OpenAICompatibleClient({
    provider: 'openai-compatible', apiKey: 'test', baseUrl: 'http://provider.invalid/v1', model: 'configured-model',
    params: { model: 'hidden-override', messages: [{ role: 'user', content: 'hidden-override' }], max_tokens: 999_999 },
  });
  await client.complete(req);
  await client.complete(req);
  assert.equal(bodies.length, 3);
  assert.ok(bodies.every((body) => body.model === 'configured-model'));
  assert.ok(bodies.every((body) => JSON.stringify(body.messages).includes('Test only.')));
  assert.equal(bodies[0]?.max_tokens, 700);
  assert.equal(bodies[1]?.max_completion_tokens, 700);
  assert.equal(bodies[2]?.max_completion_tokens, 700);
  assert.equal(bodies[2]?.max_tokens, undefined);
});
