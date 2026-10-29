import type { LLMClient, OfflineMeta } from '../llm/index.ts';
import type {
  Action,
  ActionKind,
  ConversationReply,
  ConversationLine,
  Facing,
  GoalItem,
  Look,
  Memory,
  MemoryKind,
  PlacedObject,
  PlanItem,
  Relationship,
  ResidentConfig,
  ResidentDetail,
  ResidentView,
  SimTime,
  Tile,
} from '../types.ts';
import { bool, extractJson, str, truncate } from '../util/json.ts';
import { clamp, Mutex } from '../util/random.ts';
import { isSleepTime, hhmm } from '../world/clock.ts';
import { makeLook, walkView, type Mover, type Walk } from '../world/movement.ts';
import { MemoryStream, scoreImportance } from './memory.ts';
import {
  decidePrompt,
  identityPrompt,
  planPrompt,
  reflectionPrompt,
  replyPrompt,
  type DecideContext,
  type PlanContext,
  type ReplyContext,
} from './prompts.ts';

/** What a resident needs to know about the world around it; implemented by the simulation. */
export interface WorldInfo {
  houseName: string;
  houseDescription: string;
  roomsDescription: string;
  roomIds: string[];
  housemateNames(except: string): string[];
  humanName(): string;
}

export interface ResidentSnapshot {
  name: string;
  room: string;
  pos?: Tile;
  facing?: Facing;
  mood: string;
  energy: number;
  awake: boolean;
  activity: string;
  plan: PlanItem[];
  planDay: number;
  goalsState?: GoalItem[];
  relationships: Record<string, Relationship>;
  memories: Memory[];
  lastActedTick: number;
  importanceSinceReflection: number;
  lastReflectionMemoryId?: string;
  lastReflectionTick?: number;
  lastReflectionTickMemoryIds?: string[];
}

interface MemoryLimits {
  retrieveTop: number;
  reflectionThreshold: number;
  maxMemories: number;
}

const ACTIONS = new Set<ActionKind>(['say', 'move', 'do', 'rest']);

export class Resident implements Mover {
  readonly cfg: ResidentConfig;
  readonly name: string;
  readonly isHuman = false;
  look: Look;
  llm: LLMClient;
  wakeHour: number;
  sleepHour: number;

  room: string;
  pos: Tile = { x: 0, y: 0 };
  facing: Facing = 'down';
  walk: Walk | undefined;
  /** Tile this resident is deliberately staying at (using an object, talking); suppresses wandering. */
  anchor: Tile | undefined;
  bed: PlacedObject | undefined;
  /** Thinking or carrying out an action. */
  busy = false;
  inConversation = false;
  goingToBed = false;
  /** Serialises replies to the human guest. */
  readonly guestLock = new Mutex();

  mood = 'neutral';
  energy = 85;
  awake = true;
  activity = '';
  plan: PlanItem[] = [];
  planDay = 0;
  goalsState: GoalItem[] = [];
  relationships: Record<string, Relationship> = {};
  memory: MemoryStream;
  lastActedTick = -1;
  importanceSinceReflection = 0;
  private lastReflectionMemoryId: string | undefined;
  private lastReflectionTick = -1;
  private lastReflectionTickMemoryIds = new Set<string>();
  /** Things perceived since this resident last acted — surfaced in its next prompt. */
  private noticed: { id: string; text: string; refs: string[] }[] = [];
  private noticedIds = new Set<string>();

  private readonly world: WorldInfo;
  private readonly limits: MemoryLimits;

  constructor(cfg: ResidentConfig, llm: LLMClient, world: WorldInfo, limits: MemoryLimits, snap?: ResidentSnapshot) {
    this.cfg = cfg;
    this.name = cfg.name;
    this.look = makeLook(cfg.name, cfg.color, cfg.look);
    this.llm = llm;
    this.world = world;
    this.limits = limits;
    this.wakeHour = cfg.wakeHour ?? 7;
    this.sleepHour = cfg.sleepHour ?? 23;
    this.room = cfg.startRoom ?? cfg.homeRoom;
    this.goalsState = cfg.goals.map((g) => ({ text: g, progress: 0 }));
    this.memory = new MemoryStream(limits.maxMemories, snap?.memories ?? []);
    if (snap) {
      this.room = snap.room;
      if (snap.pos) this.pos = { ...snap.pos };
      if (snap.facing) this.facing = snap.facing;
      this.mood = snap.mood;
      this.energy = snap.energy;
      this.awake = snap.awake;
      this.activity = snap.activity;
      this.plan = snap.plan;
      this.planDay = snap.planDay;
      if (snap.goalsState?.length) this.goalsState = snap.goalsState;
      this.relationships = snap.relationships;
      this.lastActedTick = snap.lastActedTick;
      this.importanceSinceReflection = snap.importanceSinceReflection;
      const lastReflection = this.memory.items.findLast((m) => m.kind === 'reflection');
      this.lastReflectionMemoryId = snap.lastReflectionMemoryId ?? lastReflection?.id;
      this.lastReflectionTick = snap.lastReflectionTick ?? lastReflection?.tick ?? -1;
      const markerIndex = this.memory.items.findIndex((m) => m.id === this.lastReflectionMemoryId);
      this.lastReflectionTickMemoryIds = new Set(snap.lastReflectionTickMemoryIds ?? this.memory.items.slice(0, markerIndex + 1).filter((m) => m.tick === this.lastReflectionTick).map((m) => m.id));
    }
  }

  // ── perception & memory ──────────────────────────────────────────────────

  shouldSleepAt(hour: number): boolean {
    return isSleepTime(hour, this.wakeHour, this.sleepHour);
  }

  activeGoalTexts(): string[] {
    return this.goalsState.filter((g) => !g.done && g.progress < 100).map((g) => g.text);
  }

  /** Records something this resident saw or heard. */
  perceive(text: string, importance: number, t: SimTime, tick: number, refs: string[] = [], kind: MemoryKind = 'observation'): void {
    const m = this.remember(kind, text, importance, t, tick, refs);
    if (!this.noticedIds.has(m.id)) {
      this.noticed.push({ id: m.id, text: `[${hhmm(t)}] ${text}`, refs: m.refs });
      this.noticedIds.add(m.id);
      if (this.noticed.length > 12) this.noticedIds.delete(this.noticed.shift()!.id);
    }
  }

  /** Records something this resident did or thought itself (not surfaced as "noticed"). */
  remember(kind: MemoryKind, text: string, importance: number, t: SimTime, tick: number, refs: string[] = []): Memory {
    const refined = kind === 'reflection' || kind === 'plan' ? importance : scoreImportance(text, importance, this.activeGoalTexts());
    if (kind === 'observation' || kind === 'action' || kind === 'conversation') this.importanceSinceReflection += refined;
    return this.memory.add(kind, text, refined, t, tick, refs);
  }

  /** True when someone addressed this resident since it last acted. */
  hasPendingAddress(): boolean {
    return this.noticed.some((n) => / said to you:| asked you:/.test(n.text));
  }

  acknowledgeConversation(lines: ConversationLine[]): void {
    this.noticed = this.noticed.filter((notice) => !lines.some((line) => notice.refs.includes(line.who) && notice.text.endsWith(`: "${line.text}"`)));
    this.noticedIds = new Set(this.noticed.map((n) => n.id));
  }

  needsReflection(): boolean {
    return this.importanceSinceReflection >= this.limits.reflectionThreshold && this.reflectionEvidence().length >= 3;
  }

  /** New experiences only: a reflection must not repeatedly reinterpret the same diary entries. */
  private reflectionEvidence(): Memory[] {
    const marker = this.memory.items.findIndex((m) => m.id === this.lastReflectionMemoryId);
    const candidates = marker >= 0
      ? this.memory.items.slice(marker + 1)
      : this.memory.items.filter((m) => m.tick > this.lastReflectionTick || (m.tick === this.lastReflectionTick && !this.lastReflectionTickMemoryIds.has(m.id)));
    return candidates.filter((m) => m.kind === 'observation' || m.kind === 'action' || m.kind === 'conversation').slice(-30);
  }

  relationship(name: string): Relationship {
    let rel = this.relationships[name];
    if (!rel) {
      rel = { impression: '', affinity: 0, interactions: 0 };
      this.relationships[name] = rel;
    }
    return rel;
  }

  updateRelationship(name: string, impression: string, warmth: number, countInteraction = true): void {
    const rel = this.relationship(name);
    if (countInteraction) rel.interactions++;
    if (impression) rel.impression = truncate(impression, 220);
    rel.affinity = clamp(rel.affinity + clamp(Math.round(warmth), -1, 1), -5, 5);
  }

  currentPlanItem(now: SimTime): PlanItem | undefined {
    const nowMin = now.hour * 60 + now.minute;
    let current: PlanItem | undefined;
    for (const item of this.plan) {
      const [h, m] = item.time.split(':').map(Number);
      if (h === undefined || Number.isNaN(h)) continue;
      const itemMin = h * 60 + (m ?? 0);
      if (itemMin <= nowMin) current = item;
    }
    return current;
  }

  tickEnergy(): void {
    this.energy = clamp(this.energy + (this.awake ? -1.5 : 4), 0, 100);
  }

  // ── thinking (LLM calls) ─────────────────────────────────────────────────

  identity(): string {
    return identityPrompt({
      cfg: this.cfg,
      goals: this.goalsState,
      houseName: this.world.houseName,
      houseDescription: this.world.houseDescription,
      roomsDescription: this.world.roomsDescription,
      housemates: this.world.housemateNames(this.name).map((n) => ({ name: n, rel: this.relationships[n] })),
      humanName: this.world.humanName(),
    });
  }

  async decide(ctx: Omit<DecideContext, 'noticed' | 'memories' | 'plan' | 'currentPlanItem' | 'energy' | 'mood' | 'activity' | 'roomIds'>): Promise<Action> {
    const noticed = this.noticed.map((n) => n.text);
    const noticedIds = new Set(this.noticedIds);
    const names = ctx.present.map((p) => p.name);
    const memories = this.memory.retrieve({
      text: [ctx.room.name, ...noticed, this.activity, this.currentPlanItem(ctx.now)?.activity ?? ''].join(' '),
      names,
      goals: this.activeGoalTexts(),
      now: ctx.now,
      top: this.limits.retrieveTop,
      exclude: noticedIds,
    });
    const prompt = decidePrompt({
      ...ctx,
      energy: this.energy,
      mood: this.mood,
      activity: this.activity,
      plan: this.plan,
      currentPlanItem: this.currentPlanItem(ctx.now),
      noticed,
      memories,
      roomIds: this.world.roomIds,
    });
    const llm = this.llm;
    const raw = await llm.complete({
      system: this.identity(),
      messages: [{ role: 'user', content: prompt }],
      kind: 'action',
      meta: this.offlineMeta(
        ctx.room.id,
        ctx.present.filter((p) => !p.human && p.activity !== 'asleep').map((p) => p.name),
        ctx.room.objects,
      ),
    });
    if (this.llm !== llm) throw new Error('Resident model changed; stale response discarded.');
    // Keep observations that arrived while the model was thinking for its next turn.
    const action = parseAction(raw);
    this.noticed = this.noticed.filter((n) => !noticedIds.has(n.id));
    for (const id of noticedIds) this.noticedIds.delete(id);
    return action;
  }

  async reply(ctx: Omit<ReplyContext, 'memories' | 'mood' | 'energy' | 'impression' | 'self'>): Promise<ConversationReply> {
    const peerNames = ctx.participants?.length ? ctx.participants.filter((n) => n !== this.name) : [ctx.partner];
    const memories = this.memory.retrieve({
      text: ctx.lines.map((l) => l.text).join(' '),
      names: peerNames,
      goals: this.activeGoalTexts(),
      now: ctx.now,
      top: Math.max(4, Math.floor(this.limits.retrieveTop / 2)),
    });
    const prompt = replyPrompt({
      ...ctx,
      self: this.name,
      mood: this.mood,
      energy: this.energy,
      impression: this.relationships[ctx.partner],
      memories,
    });
    const llm = this.llm;
    const raw = await llm.complete({
      system: this.identity(),
      messages: [{ role: 'user', content: prompt }],
      kind: 'reply',
      meta: { ...this.offlineMeta(ctx.room.id, ctx.others, ctx.room.objects), partner: ctx.partner, turn: Math.ceil(ctx.lines.length / 2) },
    });
    if (this.llm !== llm) throw new Error('Resident model changed; stale response discarded.');
    return parseReply(raw);
  }

  async makePlan(now: SimTime): Promise<{ plan: PlanItem[]; mood: string }> {
    const ctx: PlanContext = {
      now,
      yesterday: this.memory.recent(14).filter((m) => m.kind !== 'plan'),
      reflections: this.memory.ofKind('reflection', 4),
      wakeHour: this.wakeHour,
      sleepHour: this.sleepHour,
    };
    const llm = this.llm;
    const raw = await llm.complete({
      system: this.identity(),
      messages: [{ role: 'user', content: planPrompt(ctx) }],
      kind: 'plan',
      maxTokens: 900,
    });
    if (this.llm !== llm) throw new Error('Resident model changed; stale response discarded.');
    const data = extractJson<{ plan?: unknown; mood?: unknown }>(raw);
    const plan = Array.isArray(data.plan)
      ? data.plan
          .map((p: unknown) => {
            const item = (p ?? {}) as Record<string, unknown>;
            return { time: normaliseTime(str(item.time)), activity: str(item.activity) };
          })
          .filter((p) => p.time && p.activity)
          .slice(0, 10)
      : [];
    if (plan.length === 0) throw new Error(`plan had no usable items: ${truncate(raw, 120)}`);
    plan.sort((a, b) => a.time.localeCompare(b.time));
    this.plan = plan;
    this.planDay = now.day;
    if (str(data.mood)) this.mood = str(data.mood);
    return { plan, mood: this.mood };
  }

  async reflect(now: SimTime): Promise<{ insights: string[]; goalChanges: GoalItem[] }> {
    const recent = this.reflectionEvidence();
    if (recent.length === 0) return { insights: [], goalChanges: [] };
    const budget = this.importanceSinceReflection;
    const cutoff = recent.at(-1)!;
    const cutoffTickIds = this.memory.items.filter((m) => m.tick === cutoff.tick).map((m) => m.id);
    const llm = this.llm;
    const raw = await llm.complete({
      system: this.identity(),
      messages: [{ role: 'user', content: reflectionPrompt(recent, now, this.goalsState) }],
      kind: 'reflection',
      maxTokens: 700,
    });
    if (this.llm !== llm) throw new Error('Resident model changed; stale response discarded.');
    const data = extractJson<{ insights?: unknown; goalUpdates?: unknown; newGoal?: unknown }>(raw);
    const known = new Set(this.memory.ofKind('reflection', this.limits.maxMemories).map((m) => normaliseInsight(m.text)));
    const insights = (Array.isArray(data.insights) ? data.insights : [])
      .map((i) => str(i).trim())
      .filter((text) => {
        const key = normaliseInsight(text);
        if (!key || known.has(key)) return false;
        known.add(key);
        return true;
      })
      .slice(0, 4);
    const goalChanges: GoalItem[] = [];
    if (Array.isArray(data.goalUpdates)) {
      for (const u of data.goalUpdates) {
        const item = (u ?? {}) as Record<string, unknown>;
        const idx = typeof item.index === 'number' ? item.index : Number(str(item.index, '-1'));
        const prog = typeof item.progress === 'number' ? item.progress : Number(str(item.progress, '-1'));
        const target = this.goalsState[idx];
        const evidenceIds = Array.isArray(item.evidenceIds) ? item.evidenceIds.map((id) => str(id)) : [];
        const hasActionEvidence = evidenceIds.some((id) => recent.some((m) => m.id === id && m.kind === 'action'));
        if (target && Number.isInteger(idx) && hasActionEvidence && Number.isFinite(prog) && prog > target.progress) {
          target.progress = clamp(Math.round(prog), 0, 100);
          if (target.progress >= 100) target.done = true;
          goalChanges.push({ ...target });
        }
      }
    }
    const newGoal = str(data.newGoal).trim();
    if (newGoal && newGoal.length > 5 && this.goalsState.length < 6 && !this.goalsState.some((g) => g.text.toLowerCase() === newGoal.toLowerCase())) {
      const added: GoalItem = { text: truncate(newGoal, 140), progress: 0 };
      this.goalsState.push(added);
      this.cfg.goals = this.goalsState.map((g) => g.text);
      goalChanges.push({ ...added });
    }
    this.lastReflectionMemoryId = cutoff.id;
    this.lastReflectionTick = cutoff.tick;
    this.lastReflectionTickMemoryIds = new Set(cutoffTickIds);
    this.importanceSinceReflection = Math.max(0, this.importanceSinceReflection - budget);
    return { insights, goalChanges };
  }

  updateConfig(patch: Partial<ResidentConfig>, newLlm?: LLMClient): void {
    if (patch.emoji) this.cfg.emoji = patch.emoji;
    if (patch.color) {
      this.cfg.color = patch.color;
      this.look = makeLook(this.name, this.cfg.color, patch.look ?? this.cfg.look);
    }
    if (patch.age !== undefined) this.cfg.age = patch.age;
    if (patch.bio !== undefined) this.cfg.bio = patch.bio;
    if (Array.isArray(patch.traits)) this.cfg.traits = patch.traits;
    if (patch.style !== undefined) this.cfg.style = patch.style;
    if (Array.isArray(patch.goals)) {
      const prev = new Map(this.goalsState.map((g) => [g.text.toLowerCase(), g]));
      this.cfg.goals = patch.goals;
      this.goalsState = patch.goals.map((text) => prev.get(text.toLowerCase()) ?? { text, progress: 0 });
    }
    if (patch.wakeHour !== undefined) {
      this.cfg.wakeHour = patch.wakeHour;
      this.wakeHour = patch.wakeHour;
    }
    if (patch.sleepHour !== undefined) {
      this.cfg.sleepHour = patch.sleepHour;
      this.sleepHour = patch.sleepHour;
    }
    if (patch.homeRoom) this.cfg.homeRoom = patch.homeRoom;
    if (patch.provider) this.cfg.provider = patch.provider;
    if (patch.model !== undefined) this.cfg.model = patch.model;
    if (newLlm) this.llm = newLlm;
  }

  private offlineMeta(room: string, others: string[], objects: string[]): OfflineMeta {
    return { name: this.name, room, others, rooms: this.world.roomIds, objects };
  }

  // ── views & persistence ──────────────────────────────────────────────────

  view(): ResidentView {
    return {
      name: this.name,
      emoji: this.cfg.emoji,
      color: this.cfg.color,
      look: this.look,
      x: this.pos.x,
      y: this.pos.y,
      facing: this.facing,
      walk: walkView(this),
      provider: this.llm.provider,
      model: this.llm.model,
      online: this.llm.online,
      note: this.llm.note,
      mode: this.llm.mode,
      status: this.llm.status,
      canComplete: this.llm.canComplete,
      retryAt: this.llm.retryAt,
      room: this.room,
      awake: this.awake,
      mood: this.mood,
      energy: Math.round(this.energy),
      activity: this.activity,
      bio: this.cfg.bio,
      traits: this.cfg.traits,
      goals: this.goalsState.map((g) => g.text),
      goalsState: this.goalsState,
      relationships: this.relationships,
      age: this.cfg.age,
    };
  }

  detail(): ResidentDetail {
    return {
      ...this.view(),
      plan: this.plan,
      relationships: this.relationships,
      reflections: this.memory.ofKind('reflection', 12).reverse(),
      memories: this.memory.recent(60).reverse(),
    };
  }

  snapshot(): ResidentSnapshot {
    return {
      name: this.name,
      room: this.room,
      pos: { ...this.pos },
      facing: this.facing,
      mood: this.mood,
      energy: this.energy,
      awake: this.awake,
      activity: this.activity,
      plan: this.plan,
      planDay: this.planDay,
      goalsState: this.goalsState,
      relationships: this.relationships,
      memories: this.memory.items,
      lastActedTick: this.lastActedTick,
      importanceSinceReflection: this.importanceSinceReflection,
      lastReflectionMemoryId: this.lastReflectionMemoryId,
      lastReflectionTick: this.lastReflectionTick,
      lastReflectionTickMemoryIds: [...this.lastReflectionTickMemoryIds],
    };
  }
}

function normaliseInsight(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── parsing helpers ────────────────────────────────────────────────────────

function parseAction(raw: string): Action {
  const d = extractJson<Record<string, unknown>>(raw);
  let action = str(d.action).toLowerCase() as ActionKind;
  if (!ACTIONS.has(action)) {
    // Models occasionally invent verbs; map the common ones.
    if (/talk|speak|tell|ask|reply|respond/.test(action)) action = 'say';
    else if (/go|walk|head|leave|enter/.test(action)) action = 'move';
    else if (/sleep|nap|relax|idle|wait/.test(action)) action = 'rest';
    else action = 'do';
  }
  const content = str(d.content) || str(d.text) || str(d.message);
  return {
    thought: str(d.thought),
    action,
    target: str(d.target) || str(d.to) || str(d.room),
    content,
    mood: str(d.mood),
  };
}

function parseReply(raw: string): ConversationReply {
  const d = extractJson<Record<string, unknown>>(raw);
  const warmthRaw = typeof d.warmth === 'number' ? d.warmth : Number(str(d.warmth, '0'));
  return {
    thought: str(d.thought),
    content: str(d.content) || str(d.text) || str(d.message),
    end: bool(d.end),
    impression: str(d.impression),
    warmth: Number.isFinite(warmthRaw) ? warmthRaw : 0,
    nextSpeaker: str(d.nextSpeaker) || undefined,
  };
}

function normaliseTime(s: string): string {
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return '';
  let h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
