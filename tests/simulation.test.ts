import assert from 'node:assert/strict';
import test from 'node:test';
import { Simulation } from '../src/world/simulation.ts';
import type { Resident } from '../src/agents/resident.ts';
import type { CompleteRequest, LLMClient } from '../src/llm/types.ts';
import type { Action, HouseConfig } from '../src/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function client(complete: (req: CompleteRequest) => Promise<string>, available = true): LLMClient {
  return { provider: 'openai', model: 'fixture', label: 'fixture', mode: available ? 'live' : 'unavailable', status: available ? 'ready' : 'unavailable', online: available, canComplete: available, requests: 0, complete };
}

function simulation(): Simulation {
  const cfg: HouseConfig = {
    name: 'Test', description: 'A test house.', startHour: 10,
    tick: { realSeconds: 20, simMinutes: 15, concurrentThinkers: 2, conversationMaxTurns: 6 },
    movement: { wanderChance: 0 }, memory: { retrieveTop: 8, reflectionThreshold: 70, maxMemories: 400 },
    human: { name: 'Guest', emoji: 'G', color: '#cccccc', startRoom: 'study' },
    rooms: [{ id: 'study', name: 'Study', emoji: 'S', color: '#333333', description: 'A study.', x: 1, y: 1, w: 10, h: 10, objects: [] }],
    residents: ['Ada', 'Bea'].map((name) => ({ name, emoji: name[0]!, color: '#aaaaaa', provider: 'offline', bio: 'Writes articles.', traits: ['curious'], goals: ['finish the article'], homeRoom: 'study', wakeHour: 0, sleepHour: 0 })),
  };
  const sim = new Simulation(cfg);
  for (const r of sim.residents) r.planDay = sim.clock.now.day;
  internals(sim).approach = async () => true;
  return sim;
}

interface Internals {
  approach: (...args: unknown[]) => Promise<boolean>;
  act(r: Resident): Promise<void>;
  brainTick(r: Resident): Promise<void>;
  brainTimers: Map<string, NodeJS.Timeout>;
  handleSay(r: Resident, action: Action): Promise<void>;
  converse(a: Resident, peers: Resident[], opening: string): Promise<void>;
}
function internals(sim: Simulation): Internals { return sim as unknown as Internals; }

test('unavailable residents skip autonomous calls and give one clear guest status', async () => {
  const sim = simulation();
  let calls = 0;
  for (const r of sim.residents) r.llm = client(async () => { calls++; throw new Error('must not call'); }, false);
  await sim.step();
  const before = sim.events.length;
  await sim.humanSay('Hello everyone');
  assert.equal(calls, 0);
  const notices = sim.events.slice(before).filter((e) => e.type === 'system');
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.type === 'system' ? notices[0]!.text : '', /No resident here has an available model/);
});

test('guest replies reserve a resident and release all locks on success', async () => {
  const sim = simulation();
  const r = sim.residents[0]!;
  const pending = deferred<string>();
  const started = deferred<void>();
  let calls = 0;
  r.llm = client(async () => { calls++; started.resolve(); return pending.promise; });
  const conversation = sim.humanSay('I want to finish the article.', r.name);
  await started.promise;
  assert.equal(r.busy, true);
  assert.equal(r.inConversation, true);
  await internals(sim).act(r);
  assert.equal(calls, 1, 'autonomy cannot start a second concurrent request');
  pending.resolve('{"content":"Let us finish the article.","end":true,"warmth":1}');
  await conversation;
  assert.equal(r.busy, false);
  assert.equal(r.inConversation, false);
  assert.equal(r.anchor, undefined);
  assert.equal(r.goalsState[0]!.progress, 0, 'mentioning a goal is not completed work');
  assert.equal(r.relationships.Guest?.interactions, 1);
});

test('guest model failure releases reservations', async () => {
  const sim = simulation();
  const r = sim.residents[0]!;
  r.llm = client(async () => { throw new Error('fixture failure'); });
  await sim.humanSay('Hello', r.name);
  assert.equal(r.busy, false);
  assert.equal(r.inConversation, false);
  assert.equal(r.anchor, undefined);
  assert.ok(sim.events.some((e) => e.type === 'system' && /model could not answer/.test(e.text)));
});

test('autonomous speech cannot pull a busy resident into another model call', async () => {
  const sim = simulation();
  const [a, b] = sim.residents as [Resident, Resident];
  let calls = 0;
  b.busy = true;
  b.llm = client(async () => { calls++; return '{"content":"reply"}'; });
  await internals(sim).handleSay(a, { thought: '', action: 'say', target: b.name, content: 'A question?', mood: '' });
  assert.equal(calls, 0);
  assert.equal(b.inConversation, false);
  assert.equal(b.busy, true);
});

test('repeated conversation lines stop the exchange and interactions count once', async () => {
  const sim = simulation();
  const [a, b] = sim.residents as [Resident, Resident];
  for (const r of [a, b]) r.llm = client(async () => '{"content":"The same line.","warmth":1}');
  await internals(sim).converse(a, [b], 'Hello.');
  assert.equal(sim.events.filter((e) => e.type === 'say').length, 3);
  assert.equal(a.relationships[b.name]?.interactions, 1);
  assert.equal(b.relationships[a.name]?.interactions, 1);
  assert.equal(a.inConversation, false);
  assert.equal(b.inConversation, false);
  assert.equal(a.hasPendingAddress(), false);
  assert.equal(b.hasPendingAddress(), false);
});

test('removing a resident during an awaited decision suppresses output and rescheduling', async () => {
  const sim = simulation();
  const r = sim.residents[0]!;
  const pending = deferred<string>();
  const started = deferred<void>();
  r.llm = client(async () => { started.resolve(); return pending.promise; });
  sim.running = true;
  const turn = internals(sim).brainTick(r);
  await started.promise;
  sim.saveResidentConfig({ name: r.name, enabled: false });
  pending.resolve('{"action":"say","content":"This stale line must not appear."}');
  await turn;
  assert.equal(sim.events.some((e) => e.type === 'say' && e.who === r.name), false);
  assert.equal(internals(sim).brainTimers.has(r.name), false);
  sim.pause();
});

test('completion events from a replaced client cannot override current provider health', async () => {
  const sim = simulation();
  const r = sim.residents[0]!;
  const old = r.llm;
  let connectionEvents = 0;
  sim.onEvent((ev) => { if (ev.type === 'llm') connectionEvents++; });
  const request = old.complete({ system: 'Fixture', messages: [], kind: 'plan' });
  sim.saveResidentConfig({ name: r.name, provider: 'offline' });
  await request;
  assert.notEqual(r.llm, old);
  assert.equal(connectionEvents, 0);
});
