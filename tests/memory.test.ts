import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStream } from '../src/agents/memory.ts';
import type { Memory } from '../src/types.ts';

function memory(id: string, kind: Memory['kind'], text: string, index: number, importance = 8, refs: string[] = []): Memory {
  return { id, kind, text, importance, refs, tick: index, t: { day: 1, hour: 8, minute: index } };
}

const query = { text: 'kitchen dinner article', names: [], now: { day: 1, hour: 12, minute: 0 }, top: 8 };

test('loaded duplicate reflections leave context space for distinct witnessed events', () => {
  const duplicates = Array.from({ length: 20 }, (_, i) => memory(`summary-${i}`, 'reflection', 'I should spend more time with the others.', i));
  const conversation = memory('conversation', 'conversation', 'Juniper asked me to cook dinner in the kitchen.', 20, 6, ['Juniper']);
  const action = memory('action', 'action', 'I finished the article draft.', 21, 7);
  const initial = [...duplicates, conversation, action];
  const stream = new MemoryStream(400, initial);
  const result = stream.retrieve(query);

  assert.deepEqual(result.map((m) => m.id), ['summary-19', 'conversation', 'action']);
  assert.equal(stream.items.length, 22, 'retrieval must not delete saved history');
  assert.equal(initial.length, 22);
});

test('equivalent text uses its latest occurrence, even if the older copy scored higher', () => {
  const stream = new MemoryStream(400, [
    memory('old', 'reflection', 'I enjoy this house.', 0, 9),
    memory('latest', 'reflection', '  I enjoy  this house.  ', 2, 1),
  ]);
  assert.deepEqual(stream.retrieve(query).map((m) => m.id), ['latest']);
  assert.deepEqual(stream.retrieve({ ...query, exclude: new Set(['latest']) }).map((m) => m.id), ['old']);
});

test('retrieval retains provenance when identical text has different kinds or participants', () => {
  const stream = new MemoryStream(400, [
    memory('heard', 'conversation', 'Dinner is ready.', 0, 5, ['Nova']),
    memory('other-person', 'conversation', 'Dinner is ready.', 1, 5, ['Theo']),
    memory('inferred', 'reflection', 'Dinner is ready.', 2, 5, ['Nova']),
    memory('question', 'conversation', 'Dinner is ready?', 3, 5, ['Nova']),
  ]);
  assert.equal(stream.retrieve(query).length, 4);
  assert.deepEqual(stream.retrieve({ ...query, top: 0 }), []);
});

test('compaction retains event evidence despite a flood of high-importance summaries', () => {
  const initial = [
    ...Array.from({ length: 8 }, (_, i) => memory(`event-${i}`, i % 2 ? 'conversation' : 'action', `Specific witnessed event ${i}.`, i, 2)),
    memory('plan', 'plan', 'My plan for today: finish the article.', 8, 4),
    ...Array.from({ length: 11 }, (_, i) => memory(`summary-${i}`, 'reflection', 'I should spend more time with the others.', i + 9, 9)),
  ];
  const stream = new MemoryStream(20, initial);
  stream.add('thought', 'Keep it going.', 1, { day: 1, hour: 9, minute: 0 }, 21);

  const evidence = stream.items.filter((m) => m.kind === 'action' || m.kind === 'conversation');
  assert.equal(stream.items.length, 16);
  assert.equal(evidence.length, 8, 'half the retained capacity remains witnessed evidence');
  assert.ok(stream.items.some((m) => m.id === 'plan'), 'newest plan remains available');
  assert.ok(stream.items.some((m) => m.id === 'summary-10'), 'newest reflection remains available');
  assert.deepEqual(stream.items.map((m) => m.tick), [...stream.items.map((m) => m.tick)].sort((a, b) => a - b), 'retained history stays chronological');
});

test('small memory limits still retain the newest witnessed event', () => {
  const stream = new MemoryStream(1);
  stream.add('action', 'I cooked dinner.', 5, { day: 1, hour: 8, minute: 0 }, 0);
  stream.add('action', 'I washed the dishes.', 5, { day: 1, hour: 8, minute: 15 }, 1);
  assert.equal(stream.items.length, 1);
  assert.equal(stream.items[0]?.text, 'I washed the dishes.');
});
