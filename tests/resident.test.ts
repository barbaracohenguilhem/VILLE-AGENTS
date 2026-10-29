import assert from 'node:assert/strict';
import test from 'node:test';
import { Resident, type WorldInfo } from '../src/agents/resident.ts';
import { scoreImportance } from '../src/agents/memory.ts';
import type { CompleteRequest, LLMClient } from '../src/llm/types.ts';
import type { ResidentConfig } from '../src/types.ts';

const now = { day: 1, hour: 10, minute: 0 };
const cfg: ResidentConfig = { name: 'Ada', emoji: 'A', color: '#aaaaaa', provider: 'offline', bio: 'Writes articles.', traits: ['curious'], goals: ['finish the article'], homeRoom: 'study' };
const world: WorldInfo = { houseName: 'Test', houseDescription: 'A test house.', roomsDescription: 'study — Study', roomIds: ['study'], housemateNames: () => ['Bea'], humanName: () => 'Guest' };
const context = { now, room: { id: 'study', name: 'Study', description: 'A study.', objects: [] }, present: [], elsewhere: [] };
const action = JSON.stringify({ action: 'rest', content: 'resting quietly' });

function client(complete: (req: CompleteRequest) => Promise<string>): LLMClient {
  return { provider: 'openai', model: 'fixture', label: 'fixture', mode: 'live', status: 'ready', online: true, canComplete: true, requests: 0, complete };
}

function resident(llm: LLMClient, maxMemories = 400): Resident {
  return new Resident(structuredClone(cfg), llm, world, { retrieveTop: 8, reflectionThreshold: 1, maxMemories });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('perception importance is scored once and internal summaries do not fund more reflection', () => {
  const r = resident(client(async () => action));
  const text = 'Bea promised to finish the article?';
  r.perceive(text, 2, now, 1);
  assert.equal(r.memory.items[0]?.importance, scoreImportance(text, 2, r.activeGoalTexts()));
  const budget = r.importanceSinceReflection;
  for (const kind of ['thought', 'plan', 'reflection'] as const) r.remember(kind, 'Internal summary.', 8, now, 1);
  assert.equal(r.importanceSinceReflection, budget);
});

test('observations arriving during a decision remain available for the next turn', async () => {
  const pending = deferred<string>();
  const prompts: string[] = [];
  const r = resident(client(async (req) => {
    prompts.push(req.messages[0]!.content);
    return prompts.length === 1 ? pending.promise : action;
  }));
  r.perceive('Bea said to you: "First question?"', 2, now, 1);
  const decision = r.decide(context);
  r.perceive('Bea said to you: "New question while you think?"', 2, now, 1);
  pending.resolve(action);
  await decision;
  assert.equal(r.hasPendingAddress(), true);
  await r.decide(context);
  assert.match(prompts[1]!, /Things you noticed since your last turn\n- \[10:00\] Bea said to you: "New question while you think\?"/);
  assert.equal(r.hasPendingAddress(), false);
});

test('malformed or stale model replies do not consume pending observations', async () => {
  const bad = resident(client(async () => 'not valid JSON'));
  bad.perceive('Bea said to you: "Please answer."', 2, now, 1);
  await assert.rejects(bad.decide(context));
  assert.equal(bad.hasPendingAddress(), true);

  const pending = deferred<string>();
  const r = resident(client(async () => pending.promise));
  r.perceive('Bea said to you: "Still waiting."', 2, now, 1);
  const decision = r.decide(context);
  r.updateConfig({}, client(async () => action));
  pending.resolve(action);
  await assert.rejects(decision, /stale response discarded/);
  assert.equal(r.hasPendingAddress(), true);
});

test('reflections deduplicate insights and require action evidence for goal progress', async () => {
  let evidenceId = '';
  const r = resident(client(async () => JSON.stringify({
    insights: ['I prefer quiet mornings.', 'A new concrete insight.', 'A new concrete insight.'],
    goalUpdates: [{ index: 0, progress: 60 }, { index: 0, progress: 25, evidenceIds: [evidenceId] }],
  })));
  r.remember('reflection', 'I prefer quiet mornings.', 8, now, 0);
  r.perceive('Bea talked about finishing the article.', 5, now, 1, [], 'conversation');
  const noEvidence = await r.reflect(now);
  assert.deepEqual(noEvidence.insights, ['A new concrete insight.']);
  assert.equal(r.goalsState[0]?.progress, 0);
  assert.deepEqual(noEvidence.goalChanges, []);
  assert.deepEqual(await r.reflect(now), { insights: [], goalChanges: [] });

  evidenceId = r.remember('action', 'I completed the article draft.', 5, now, 2).id;
  const supported = await r.reflect(now);
  assert.equal(supported.goalChanges[0]?.progress, 25);
});

test('new same-tick evidence survives a pending reflection, marker eviction, and restore', async () => {
  const pending = deferred<string>();
  const prompts: string[] = [];
  const llm = client(async (req) => {
    prompts.push(req.messages[0]!.content);
    return prompts.length === 1 ? pending.promise : '{"insights":[]}';
  });
  const r = resident(llm);
  const old = r.remember('action', 'I made breakfast.', 3, now, 1);
  const reflection = r.reflect(now);
  r.perceive('Bea said to you: "New dinner invitation."', 4, now, 1, [], 'conversation');
  const newBudget = r.importanceSinceReflection - old.importance;
  pending.resolve('{"insights":[]}');
  await reflection;
  assert.equal(r.importanceSinceReflection, newBudget);
  r.memory.items = r.memory.items.filter((m) => m.id !== old.id); // Compaction can evict the cutoff entry.
  const restored = new Resident(structuredClone(cfg), llm, world, { retrieveTop: 8, reflectionThreshold: 1, maxMemories: 400 }, r.snapshot());
  await restored.reflect(now);
  assert.match(prompts[1]!, /New dinner invitation/);
  assert.doesNotMatch(prompts[1]!, /I made breakfast/);
});

test('finishing a conversation acknowledges its lines while preserving unrelated observations', () => {
  const r = resident(client(async () => action));
  r.perceive('Bea said to you: "Dinner at seven?"', 3, now, 1, ['Bea'], 'conversation');
  r.perceive('Guest said to you: "Dinner at seven?"', 3, now, 1, ['Guest'], 'conversation');
  r.acknowledgeConversation([{ who: 'Bea', text: 'Dinner at seven?' }]);
  assert.equal(r.hasPendingAddress(), true);
  r.acknowledgeConversation([{ who: 'Guest', text: 'Dinner at seven?' }]);
  assert.equal(r.hasPendingAddress(), false);
});

test('provider swaps also invalidate pending plan, reflection, and reply results', async () => {
  for (const kind of ['plan', 'reflection', 'reply'] as const) {
    const pending = deferred<string>();
    const r = resident(client(async () => pending.promise));
    r.remember('action', 'I finished a draft.', 3, now, 1);
    const operation = kind === 'plan' ? r.makePlan(now)
      : kind === 'reflection' ? r.reflect(now)
        : r.reply({ now, room: context.room, partner: 'Bea', partnerIsHuman: false, others: [], lines: [{ who: 'Bea', text: 'Hello' }], turnsLeft: 2 });
    r.updateConfig({}, client(async () => action));
    pending.resolve('{"plan":[{"time":"10:00","activity":"old plan"}],"insights":["Old insight"],"content":"Old reply"}');
    await assert.rejects(operation, /stale response discarded/);
    assert.deepEqual(r.plan, []);
    assert.equal(r.goalsState[0]?.progress, 0);
  }
});
