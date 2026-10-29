import type { Memory, MemoryKind, SimTime } from '../types.ts';
import { uid } from '../util/random.ts';
import { toMinutes } from '../world/clock.ts';

const STOP = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'what', 'about', 'they', 'them', 'their', 'there', 'then',
  'than', 'were', 'been', 'being', 'into', 'just', 'like', 'some', 'said', 'told', 'went', 'came', 'will', 'would',
  'could', 'should', 'your', 'yours', 'mine', 'ours', 'also', 'very', 'really', 'here', 'where', 'when', 'while',
]);

function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3).replace(/([bcdfghjklmnpqrstvwxz])\1$/, '$1');
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) {
    if (!STOP.has(w)) {
      out.add(w);
      out.add(stem(w));
    }
  }
  return out;
}

const SALIENT_WORDS = new Set([
  'love', 'hate', 'angry', 'upset', 'secret', 'worry', 'worried', 'afraid', 'promise', 'promised', 'sorry',
  'apologise', 'apologize', 'proud', 'finished', 'finish', 'finally', 'fixed', 'broke', 'broken', 'tournament',
  'dinner', 'party', 'stargazing', 'album', 'song', 'article', 'portrait', 'painting', 'crossword', 'argument',
]);

/** Refines a base importance score (1..9) using goal overlap, questions, and emotional salience. */
export function scoreImportance(text: string, base: number, goalTexts: string[] = []): number {
  let score = base;
  const tokens = tokenize(text);
  let salientHits = 0;
  for (const w of tokens) {
    if (SALIENT_WORDS.has(w)) salientHits++;
  }
  if (salientHits > 0) score += Math.min(2, salientHits);
  if (text.includes('?')) score += 0.5;
  if (goalTexts.length > 0) {
    const goalWords = tokenize(goalTexts.join(' '));
    let goalOverlap = 0;
    for (const w of tokens) if (goalWords.has(w)) goalOverlap++;
    if (goalOverlap >= 2) score += 2;
    else if (goalOverlap === 1) score += 1;
  }
  return Math.max(1, Math.min(9, Math.round(score)));
}

export interface RetrievalQuery {
  text: string;
  names: string[];
  goals?: string[];
  now: SimTime;
  top: number;
  exclude?: Set<string>;
}

function contentKey(m: Memory): string {
  const text = m.text.trim().toLowerCase().replace(/\s+/g, ' ');
  const refs = m.refs.map((r) => r.toLowerCase()).sort().join('\0');
  return `${m.kind}\0${refs}\0${text}`;
}

/**
 * A resident's memory stream, in the spirit of "Generative Agents": every
 * observation is stored with an importance score and retrieved by a blend of
 * recency, importance and relevance to the current situation.
 */
export class MemoryStream {
  items: Memory[] = [];
  private readonly max: number;

  constructor(max: number, initial: Memory[] = []) {
    this.max = max;
    this.items = initial;
  }

  add(kind: MemoryKind, text: string, importance: number, t: SimTime, tick: number, refs: string[] = []): Memory {
    const m: Memory = { id: uid('m'), kind, t, tick, text, importance, refs };
    this.items.push(m);
    if (this.items.length > this.max) this.compact();
    return m;
  }

  /** Retains useful summaries without letting them crowd out the events behind them. */
  private compact(): void {
    const keep = Math.max(1, Math.floor(this.max * 0.8));
    const scored = this.items.map((m, i) => ({
      m,
      score: m.importance + i / this.items.length,
    }));
    scored.sort((a, b) => b.score - a.score);
    const survivors = new Set<string>();
    const evidence = scored.filter(({ m }) => m.kind === 'observation' || m.kind === 'conversation' || m.kind === 'action');
    for (const { m } of evidence.slice(0, Math.ceil(keep / 2))) survivors.add(m.id);
    // Keep the newest plan and reflection when there is room, then fill by value.
    for (const kind of ['plan', 'reflection'] as const) {
      const latest = this.items.findLast((m) => m.kind === kind);
      if (latest && survivors.size < keep) survivors.add(latest.id);
    }
    for (const { m } of scored) {
      if (survivors.size >= keep) break;
      survivors.add(m.id);
    }
    this.items = this.items.filter((m) => survivors.has(m.id));
  }

  recent(n: number): Memory[] {
    return this.items.slice(-n);
  }

  ofKind(kind: MemoryKind, n: number): Memory[] {
    return this.items.filter((m) => m.kind === kind).slice(-n);
  }

  retrieve(q: RetrievalQuery): Memory[] {
    if (q.top <= 0) return [];
    const nowMin = toMinutes(q.now);
    const words = tokenize(q.text);
    const goalWords = q.goals?.length ? tokenize(q.goals.join(' ')) : new Set<string>();
    const names = new Set(q.names.map((n) => n.toLowerCase()));

    // Repeated entries must not consume the context or distort relevance weights.
    // Keep the latest available occurrence without rewriting the stored history.
    const unique = new Map<string, { m: Memory; i: number }>();
    this.items.forEach((m, i) => {
      if (!q.exclude?.has(m.id)) unique.set(contentKey(m), { m, i });
    });
    // Compute document frequency across distinct candidates for IDF weighting.
    const df = new Map<string, number>();
    const tokenizedItems = [...unique.values()].map(({ m, i }) => {
      const mw = tokenize(m.text);
      for (const w of mw) if (words.has(w) || goalWords.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
      return { m, mw, i };
    });
    const N = Math.max(1, tokenizedItems.length);

    const scored = tokenizedItems
      .map(({ m, mw, i }) => {
        const ageMin = Math.max(0, nowMin - toMinutes(m.t));
        const halfLife = m.kind === 'reflection' ? 1440 : 480;
        const recency = Math.exp(-ageMin / halfLife);
        let weightedOverlap = 0;
        for (const w of words) {
          if (mw.has(w)) {
            const idf = 1 + Math.log((N + 1) / ((df.get(w) ?? 1) + 1));
            weightedOverlap += idf;
          }
        }
        const relevance = words.size ? weightedOverlap / Math.sqrt(words.size) : 0;
        let goalOverlap = 0;
        for (const gw of goalWords) if (mw.has(gw)) goalOverlap++;
        const goalBonus = goalWords.size && goalOverlap > 0 ? Math.min(0.45, goalOverlap * 0.18) : 0;
        const nameBonus = m.refs.some((r) => names.has(r.toLowerCase())) ? 0.65 : 0;
        const kindBonus = m.kind === 'reflection' ? 0.25 : 0;
        return { m, i, score: recency + m.importance * 0.13 + relevance + goalBonus + nameBonus + kindBonus };
      });
    scored.sort((a, b) => b.score - a.score || b.i - a.i);
    return scored
      .slice(0, q.top)
      .map(({ m }) => m)
      .sort((a, b) => toMinutes(a.t) - toMinutes(b.t));
  }
}
