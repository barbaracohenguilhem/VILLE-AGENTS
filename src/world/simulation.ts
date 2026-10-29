import { EventEmitter } from 'node:events';
import type { PresentPerson } from '../agents/prompts.ts';
import { Resident, type WorldInfo } from '../agents/resident.ts';
import { createClient, setConcurrency, stats as llmStats, type LLMClient } from '../llm/index.ts';
import type {
  Action,
  ConversationLine,
  Facing,
  HouseConfig,
  HumanView,
  Look,
  ObjectConfig,
  PlacedObject,
  ResidentConfig,
  ResidentDetail,
  ResidentView,
  Snapshot,
  Tile,
  VilleEvent,
  WalkPurpose,
} from '../types.ts';
import { truncate } from '../util/json.ts';
import { chance, clamp, pick, uid, waitFor } from '../util/random.ts';
import { Clock } from './clock.ts';
import { centerOf, facingToward, manhattan, sameTile } from './grid.ts';
import { House, KINDS } from './house.ts';
import { inTransit, makeLook, Movement, walkView, type Mover, type Walk } from './movement.ts';
import type { SavedState, Store } from './store.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventInput = DistributiveOmit<VilleEvent, 'id' | 't' | 'tick'>;

const MAX_EVENTS = 400;
const TRANSIENT: ReadonlySet<VilleEvent['type']> = new Set(['llm', 'walk', 'pos', 'mood']);
const SEATS = ['sofa', 'armchair', 'bench', 'beanbag', 'chair', 'bed'];

interface Human extends Mover {
  readonly isHuman: true;
  emoji: string;
  color: string;
  name: string;
}

export class Simulation {
  readonly cfg: HouseConfig;
  house: House;
  readonly clock: Clock;
  readonly residents: Resident[] = [];
  readonly human: Human;
  events: VilleEvent[] = [];
  tick = 0;
  running = false;
  speed = 1;

  private readonly emitter = new EventEmitter();
  private readonly store: Store | undefined;
  private readonly movement: Movement;
  private readonly baseTileMs: number;
  private readonly wanderChance: number;
  private readonly worldInfo: WorldInfo;
  private clockTimer: NodeJS.Timeout | undefined;
  private readonly moveTimer: NodeJS.Timeout;
  private brainTimers = new Map<string, NodeJS.Timeout>();
  private brainActive = new Set<string>();
  private guestConvos = new Map<string, ConversationLine[]>();

  constructor(cfg: HouseConfig, store?: Store) {
    this.cfg = cfg;
    this.house = new House(cfg);
    this.store = store;
    this.baseTileMs = cfg.movement?.tileMs ?? 260;
    this.wanderChance = cfg.movement?.wanderChance ?? 0.06;
    setConcurrency(cfg.tick.concurrentThinkers ?? 3);
    const saved = store?.load();

    this.clock = new Clock(cfg.startHour, saved?.time);
    this.tick = saved?.tick ?? 0;
    this.events = saved?.events ?? [];

    this.movement = new Movement({
      onWalk: (m, w) => this.onWalk(m, w),
      onArrive: (m, w) => this.onArrive(m, w),
      onStop: (m) => this.onStop(m),
    });

    const humanName = saved?.human.name ?? cfg.human.name;
    const humanRoom = saved?.human.room && this.house.has(saved.human.room) ? saved.human.room : cfg.human.startRoom;
    if (!this.house.has(humanRoom)) throw new Error(`human.startRoom "${humanRoom}" is not a room`);
    this.human = {
      isHuman: true,
      name: humanName,
      emoji: cfg.human.emoji,
      color: cfg.human.color,
      look: makeLook(humanName, cfg.human.color, cfg.human.look),
      room: humanRoom,
      pos: this.house.grid.randomFloor(this.house.index(humanRoom)) ?? { x: 1, y: 1 },
      facing: 'down',
      walk: undefined,
    };

    const world: WorldInfo = {
      get houseName() {
        return cfg.name;
      },
      get houseDescription() {
        return cfg.description;
      },
      roomsDescription: this.house.describeAll(),
      roomIds: this.house.rooms.map((r) => r.id),
      housemateNames: (except) => this.residents.map((r) => r.name).filter((n) => n !== except),
      humanName: () => this.human.name,
    };
    this.worldInfo = world;

    for (const rc of cfg.residents) {
      if (rc.enabled === false) continue;
      if (!this.house.has(rc.homeRoom)) throw new Error(`${rc.name}: homeRoom "${rc.homeRoom}" is not a room`);
      if (rc.startRoom && !this.house.has(rc.startRoom)) throw new Error(`${rc.name}: startRoom "${rc.startRoom}" is not a room`);
      const llm = this.clientFor(rc);
      const snap = saved?.residents.find((s) => s.name === rc.name);
      const r = new Resident(rc, llm, world, cfg.memory, snap);
      if (!snap && r.shouldSleepAt(this.clock.time.hour)) {
        r.awake = false;
        r.room = rc.homeRoom;
        r.activity = 'sleeping';
      }
      this.residents.push(r);
    }
    if (this.residents.length === 0) throw new Error('no enabled residents in house.json');
    this.assignBeds();
    for (const r of this.residents) this.placeInitially(r, !!saved?.residents.find((s) => s.name === r.name));

    this.moveTimer = setInterval(() => this.movementStep(), 100);
    this.moveTimer.unref();

    const unavailable = this.residents.filter((r) => r.llm.mode === 'unavailable');
    const demo = this.residents.filter((r) => r.llm.mode === 'demo');
    this.emit({
      type: 'system',
      level: 'info',
      text: saved
        ? `Welcome back. Restored ${this.residents.length} residents from a previous session.`
        : `The house wakes up: ${this.residents.map((r) => r.name).join(', ')} move in.`,
    });
    for (const r of unavailable) {
      this.emit({
        type: 'system',
        level: 'warn',
        text: `${r.name}'s configured model is unavailable (${r.llm.note}). Their autonomous decisions are waiting for a connection.`,
      });
    }
    if (demo.length) this.emit({ type: 'system', level: 'info', text: `Scripted demo residents: ${demo.map((r) => r.name).join(', ')}. Their activity is generated by templates, not a model.` });
  }

  // ── setup ────────────────────────────────────────────────────────────────

  private clientFor(cfg: ResidentConfig): LLMClient {
    const client = createClient(cfg, (rec) => {
      // A removed resident or a replaced provider must not overwrite the current connection state.
      const resident = this.residents.find((r) => r.name === cfg.name);
      if (resident?.llm === client) this.emit({ type: 'llm', ...rec });
    });
    return client;
  }

  private assignBeds(): void {
    const used = new Set<string>();
    for (const r of this.residents) {
      const bed = this.house.objectsIn(r.cfg.homeRoom).find((o) => o.kind === 'bed' && !used.has(o.id));
      if (bed) {
        used.add(bed.id);
        r.bed = bed;
      }
    }
  }

  private placeInitially(r: Resident, restored: boolean): void {
    const grid = this.house.grid;
    if (!this.house.has(r.room)) r.room = r.cfg.homeRoom;
    const roomIdx = this.house.index(r.room);
    if (restored && grid.canStand(r.pos.x, r.pos.y) && (grid.roomAt(r.pos.x, r.pos.y) === roomIdx || !r.awake)) return;
    if (!r.awake) {
      if (r.bed) {
        r.room = r.bed.room;
        r.pos = { x: r.bed.x, y: r.bed.y };
        return;
      }
      r.pos = grid.randomFloor(roomIdx) ?? { x: 1, y: 1 };
      return;
    }
    r.pos = grid.randomFloor(roomIdx) ?? { x: 1, y: 1 };
  }

  // ── events ───────────────────────────────────────────────────────────────

  onEvent(fn: (ev: VilleEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }

  private emit(input: EventInput): VilleEvent {
    const ev = { ...input, id: uid(), t: this.clock.now, tick: this.tick } as VilleEvent;
    if (!TRANSIENT.has(ev.type)) {
      this.events.push(ev);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.emitter.emit('event', ev);
    return ev;
  }

  private emitPos(m: Mover): void {
    this.emit({ type: 'pos', who: m.name, human: m.isHuman || undefined, x: m.pos.x, y: m.pos.y, facing: m.facing, room: m.room });
  }

  // ── control ──────────────────────────────────────────────────────────────

  private get tickMs(): number {
    return (this.cfg.tick.realSeconds * 1000) / this.speed;
  }

  private get tileMs(): number {
    return clamp(Math.round(this.baseTileMs / this.speed), 70, 2000);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.emit({ type: 'system', level: 'info', text: 'Time flows again.' });
    this.scheduleClock();
    this.residents.forEach((r, i) => this.scheduleBrain(r, (this.tickMs * (i + 1)) / (this.residents.length + 1)));
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    if (this.clockTimer) clearTimeout(this.clockTimer);
    this.clockTimer = undefined;
    for (const t of this.brainTimers.values()) clearTimeout(t);
    this.brainTimers.clear();
    this.emit({ type: 'system', level: 'info', text: 'Time is paused.' });
  }

  /** Advance one tick while paused: the clock moves and everyone awake gets a turn. */
  async step(): Promise<void> {
    if (this.running) return;
    this.clockTick();
    await Promise.all(this.residents.filter((r) => r.awake && !r.busy && !r.inConversation && !r.goingToBed).map((r) => this.act(r)));
  }

  setSpeed(speed: number): void {
    this.speed = clamp(speed, 0.25, 8);
    if (this.running) this.scheduleClock();
  }

  setHumanName(name: string): void {
    const clean = name.trim().slice(0, 24);
    if (!clean || clean === this.human.name) return;
    this.human.name = clean;
    this.emit({ type: 'system', level: 'info', text: `The guest is now called ${clean}.` });
    this.save();
  }

  private scheduleClock(): void {
    if (this.clockTimer) clearTimeout(this.clockTimer);
    this.clockTimer = setTimeout(() => {
      this.clockTimer = undefined;
      if (!this.running) return;
      this.clockTick();
      this.scheduleClock();
    }, this.tickMs);
  }

  private scheduleBrain(r: Resident, delay: number): void {
    if (!this.residents.includes(r)) return;
    if (this.brainTimers.has(r.name) || this.brainActive.has(r.name)) return;
    const timer = setTimeout(() => {
      this.brainTimers.delete(r.name);
      void this.brainTick(r);
    }, delay);
    this.brainTimers.set(r.name, timer);
  }

  private async brainTick(r: Resident): Promise<void> {
    if (!this.running || !this.residents.includes(r)) return;
    this.brainActive.add(r.name);
    try {
      if (r.awake && !r.busy && !r.inConversation && !r.goingToBed && r.llm.canComplete) await this.act(r);
    } finally {
      this.brainActive.delete(r.name);
      if (this.running && this.residents.includes(r)) this.scheduleBrain(r, this.tickMs * (0.8 + Math.random() * 0.4));
    }
  }

  // ── the clock ────────────────────────────────────────────────────────────

  private clockTick(): void {
    this.tick++;
    this.clock.advance(this.cfg.tick.simMinutes);
    this.emit({ type: 'clock' });
    for (const r of this.residents) {
      r.tickEnergy();
      this.handleSleepWake(r);
    }
    this.save();
  }

  private handleSleepWake(r: Resident): void {
    const shouldSleep = r.shouldSleepAt(this.clock.time.hour);
    if (shouldSleep && r.awake && !r.goingToBed) void this.goToBed(r);
    else if (!shouldSleep && !r.awake) this.wakeUp(r);
  }

  private async goToBed(r: Resident): Promise<void> {
    r.goingToBed = true;
    try {
      const free = await waitFor(() => !r.inConversation && !r.busy, 90_000);
      if (!free) return;
      if (!r.awake || !r.shouldSleepAt(this.clock.time.hour)) return;
      r.busy = true;
      r.anchor = undefined;
      const homeIdx = this.house.index(r.cfg.homeRoom);
      const dest = r.bed ? this.house.standSpot(r.bed, r.pos) : this.house.grid.randomFloor(homeIdx);
      if (dest) await this.walkTo(r, dest, r.cfg.homeRoom, 'bed', 'heading off to bed');
      if (!r.awake) return;
      const now = this.clock.now;
      r.awake = false;
      r.activity = 'sleeping';
      r.facing = 'down';
      if (r.bed) r.pos = { x: r.bed.x, y: r.bed.y };
      r.remember('action', 'I went to bed.', 2, now, this.tick);
      this.emit({ type: 'sleep', room: r.room, who: r.name, asleep: true });
      this.emitPos(r);
      for (const o of this.awakeIn(r.room, r)) o.perceive(`${r.name} went to bed.`, 1, now, this.tick, [r.name]);
    } finally {
      r.busy = false;
      r.goingToBed = false;
    }
  }

  private wakeUp(r: Resident): void {
    const now = this.clock.now;
    r.awake = true;
    r.activity = 'just woke up';
    if (r.bed) {
      const spot = this.house.standSpot(r.bed, undefined, { beside: true });
      if (spot) {
        r.pos = { ...spot };
        r.facing = facingToward(spot, centerOf(r.bed));
      }
    }
    r.remember('action', 'I woke up.', 2, now, this.tick);
    this.emit({ type: 'sleep', room: r.room, who: r.name, asleep: false });
    this.emitPos(r);
    for (const o of this.awakeIn(r.room, r)) o.perceive(`${r.name} woke up.`, 1, now, this.tick, [r.name]);
  }

  // ── movement ─────────────────────────────────────────────────────────────

  private movers(): Mover[] {
    return [...this.residents, this.human];
  }

  private movementStep(): void {
    const now = Date.now();
    for (const m of this.movers()) this.movement.advance(m, now);
    if (!this.running) return;
    for (const r of this.residents) {
      if (!r.awake || r.busy || r.inConversation || r.goingToBed || r.walk || r.anchor) continue;
      if (!chance(this.wanderChance / 10)) continue;
      const dest = this.house.grid.randomFloor(this.house.index(r.room), { near: r.pos, radius: 4 });
      if (dest) void this.walkTo(r, dest, r.room, 'wander');
    }
  }

  /** Walks a mover to a tile; resolves true on arrival, false if interrupted. */
  private async walkTo(m: Mover, dest: Tile, toRoom: string, purpose: WalkPurpose, text = ''): Promise<boolean> {
    if (m.walk) this.movement.stop(m);
    if (sameTile(m.pos, dest)) {
      if (toRoom !== m.room) this.changeRoom(m, toRoom, text);
      return true;
    }
    const path = this.house.grid.findPath(m.pos, dest);
    if (!path) {
      // Should not happen in a connected house; teleport rather than stand there forever.
      m.pos = { ...dest };
      if (toRoom !== m.room) this.changeRoom(m, toRoom, text);
      this.emitPos(m);
      return true;
    }
    return this.movement.start(m, path, { tileMs: this.tileMs, toRoom, purpose, text });
  }

  private onWalk(m: Mover, w: Walk): void {
    this.emit({
      type: 'walk',
      who: m.name,
      human: m.isHuman || undefined,
      path: w.path,
      tileMs: w.tileMs,
      fromRoom: w.fromRoom,
      toRoom: w.toRoom,
      purpose: w.purpose,
    });
    if (w.toRoom === w.fromRoom) return;
    const now = this.clock.now;
    const fromName = this.house.nameOf(w.fromRoom);
    this.emit({ type: 'move', who: m.name, fromRoom: w.fromRoom, toRoom: w.toRoom, text: w.text, human: m.isHuman || undefined });
    const label = m.isHuman ? `${m.name} (the guest)` : m.name;
    for (const o of this.awakeIn(w.fromRoom, m)) o.perceive(`${label} left the ${fromName}${w.text ? ` (${w.text})` : ''}.`, 1, now, this.tick, [m.name]);
    if (m.isHuman) this.guestConvos.clear();
  }

  private onArrive(m: Mover, w: Walk): void {
    if (w.toRoom !== m.room) this.changeRoom(m, w.toRoom, w.text);
    this.emitPos(m);
  }

  private onStop(m: Mover): void {
    const here = this.house.roomIdAt(m.pos);
    if (here && here !== m.room) this.changeRoom(m, here, '');
    this.emitPos(m);
  }

  private changeRoom(m: Mover, toRoom: string, text: string): void {
    const now = this.clock.now;
    const fromName = this.house.nameOf(m.room);
    const toName = this.house.nameOf(toRoom);
    m.room = toRoom;
    if (m instanceof Resident) {
      m.remember('action', `I went from the ${fromName} to the ${toName}${text ? ` — ${text}` : ''}.`, 2, now, this.tick);
      for (const o of this.awakeIn(toRoom, m)) o.perceive(`${m.name} came into the ${toName}${text ? `, ${text}` : ''}.`, 2, now, this.tick, [m.name]);
    } else {
      for (const o of this.awakeIn(toRoom)) o.perceive(`${m.name} (a human guest) came into the ${toName}.`, 4, now, this.tick, [m.name]);
      this.guestConvos.clear();
    }
  }

  private face(m: Mover, toward: Tile): void {
    const f: Facing = facingToward(m.pos, toward);
    if (f !== m.facing) {
      m.facing = f;
      this.emitPos(m);
    }
  }

  private faceEachOther(a: Mover, b: Mover): void {
    this.face(a, b.pos);
    this.face(b, a.pos);
  }

  /** Walks `m` to stand next to `target` (if not already adjacent) and turns both to face each other. */
  private async approach(m: Mover, target: Mover, purpose: WalkPurpose = 'approach'): Promise<boolean> {
    if (manhattan(m.pos, target.pos) > 1) {
      const spot = this.house.grid.closestStand(target.pos, m.pos);
      if (spot) {
        const ok = await this.walkTo(m, spot, m.room, purpose);
        if (!ok) return false;
      }
    }
    this.faceEachOther(m, target);
    return true;
  }

  // ── acting ───────────────────────────────────────────────────────────────

  private async act(r: Resident): Promise<void> {
    if (!this.residents.includes(r) || !r.awake || r.busy || r.inConversation || r.goingToBed || !r.llm.canComplete || r.lastActedTick === this.tick) return;
    r.busy = true;
    try {
      const now = this.clock.now;
      if (r.planDay !== now.day) await this.planDay(r);
      if (r.needsReflection()) await this.reflect(r);

      const action = await r.decide({
        now,
        room: this.house.info(r.room),
        present: this.presentFor(r),
        elsewhere: this.residents
          .filter((o) => o !== r && o.room !== r.room)
          .map((o) => ({ name: o.name, room: this.house.nameOf(o.room), awake: o.awake })),
      });
      r.lastActedTick = this.tick;
      // Someone pulled us into a conversation (or bedtime came) while we were thinking.
      if (!this.residents.includes(r) || r.inConversation || !r.awake) return;

      if (action.mood) r.mood = truncate(action.mood, 24);
      if (action.thought) {
        this.emit({ type: 'thought', who: r.name, text: action.thought });
        r.remember('thought', `I thought: ${action.thought}`, 1, now, this.tick);
      }

      switch (action.action) {
        case 'say':
          await this.handleSay(r, action);
          break;
        case 'move':
          await this.handleMove(r, action);
          break;
        case 'rest':
          await this.handleRest(r, action);
          break;
        default:
          await this.handleDo(r, action.content);
      }
      this.emit({ type: 'mood', who: r.name, mood: r.mood, energy: Math.round(r.energy), activity: r.activity });
    } catch (err) {
      r.lastActedTick = this.tick;
      this.emit({
        type: 'system',
        level: 'warn',
        text: `${r.name} lost their train of thought (${r.llm.label}): ${truncate((err as Error).message, 220)}`,
      });
    } finally {
      r.busy = false;
    }
  }

  private async handleSay(r: Resident, action: Action): Promise<void> {
    const text = action.content;
    if (!text) {
      await this.handleDo(r, 'opening their mouth to speak, then thinking better of it');
      return;
    }
    const target = this.findResident(action.target);
    const roomPeers = this.awakeIn(r.room, r).filter((o) => !inTransit(o) && !o.goingToBed && o.llm.canComplete);
    if (target && target !== r && target.room === r.room && target.awake && !inTransit(target)) {
      // Do not pull someone out of a decision or another conversation.
      const free = !target.inConversation && !target.busy;
      if (free && target.room === r.room && target.awake && !target.inConversation && !target.busy && !target.goingToBed && target.llm.canComplete) {
        const extraPeers = roomPeers
          .filter((o) => o !== target && !o.inConversation && !o.busy)
          .filter(() => chance(0.55))
          .slice(0, 2);
        await this.converse(r, [target, ...extraPeers], text, target.name);
        return;
      }
      this.say(r, target.name, text);
      return;
    }
    const toHuman = this.human.room === r.room && !inTransit(this.human) && this.isHumanName(action.target);
    if (toHuman) {
      await this.approach(r, this.human);
      this.say(r, this.human.name, text);
      this.guestLines(r.name).push({ who: r.name, text });
      return;
    }
    // Addressing "everyone" (or the room at large): if awake free housemates are here, open a group chat!
    const availablePeers = roomPeers.filter((o) => !o.inConversation && !o.busy).slice(0, 3);
    if (availablePeers.length > 0) {
      await this.converse(r, availablePeers, text, availablePeers.length > 1 ? 'everyone' : availablePeers[0]!.name);
    } else {
      this.say(r, 'everyone', text);
    }
  }

  private async converse(a: Resident, peers: Resident[], opening: string, openingTarget = peers[0]?.name ?? 'everyone'): Promise<void> {
    const group = [a, ...peers];
    for (const p of group) p.inConversation = true;
    try {
      for (const p of peers) if (p.walk) this.movement.stop(p);
      const primary = peers[0]!;
      const reached = await this.approach(a, primary);
      if (!reached || primary.room !== a.room || !primary.awake) {
        this.say(a, 'everyone', opening);
        return;
      }
      // Bring additional group participants closer and face the circle.
      for (const p of peers.slice(1)) {
        if (p.room === a.room && p.awake) {
          await this.approach(p, a);
        }
      }
      for (const p of group) p.anchor = { ...p.pos };

      const conversationId = uid('c');
      const lines: ConversationLine[] = [{ who: a.name, text: opening }];
      this.say(a, openingTarget, opening, conversationId);

      const isGroup = group.length > 2;
      for (const p of group) {
        const othersNames = group.filter((o) => o !== p).map((o) => o.name);
        p.activity = `${isGroup ? 'group chat with' : 'talking with'} ${othersNames.join(' & ')}`;
        if (p !== a) this.emit({ type: 'mood', who: p.name, mood: p.mood, energy: Math.round(p.energy), activity: p.activity });
      }

      const maxLines = Math.max(2, this.cfg.tick.conversationMaxTurns + (isGroup ? 2 : 0));
      let lastSpeaker = a;
      let turnIdx = 1;
      while (lines.length < maxLines) {
        // Choose next speaker in the circle (must still be in the room and awake).
        const activePeers = group.filter((p) => this.residents.includes(p) && p.room === a.room && p.awake && p.llm.canComplete);
        if (activePeers.length < 2) break;
        const speaker = activePeers[turnIdx % activePeers.length] === lastSpeaker
          ? activePeers[(turnIdx + 1) % activePeers.length]!
          : activePeers[turnIdx % activePeers.length]!;
        turnIdx++;

        try {
          this.face(speaker, lastSpeaker.pos);
          const reply = await speaker.reply({
            now: this.clock.now,
            room: this.house.info(speaker.room),
            partner: lastSpeaker.name,
            partnerIsHuman: false,
            participants: activePeers.map((p) => p.name),
            others: this.awakeIn(speaker.room, speaker)
              .filter((o) => !activePeers.includes(o))
              .map((o) => o.name)
              .concat(this.human.room === speaker.room ? [this.human.name] : []),
            lines,
            turnsLeft: maxLines - lines.length,
          });
          if (!reply.content || !this.residents.includes(speaker) || speaker.room !== a.room || !speaker.awake) break;
          // A repeated line adds no information and can otherwise create endless canned loops.
          if (lines.some((line) => line.who === speaker.name && normaliseLine(line.text) === normaliseLine(reply.content))) break;
          lines.push({ who: speaker.name, text: reply.content });
          if (reply.thought) this.emit({ type: 'thought', who: speaker.name, text: reply.thought });
          const nextPeer = reply.nextSpeaker
            ? activePeers.find((p) => p !== speaker && p.name.toLowerCase() === reply.nextSpeaker?.toLowerCase())
            : undefined;
          const addressed = isGroup ? (nextPeer?.name ?? 'everyone') : lastSpeaker.name;
          this.say(speaker, addressed, reply.content, conversationId);
          if (reply.impression || reply.warmth) speaker.updateRelationship(lastSpeaker.name, reply.impression, reply.warmth, false);
          if (reply.end) break;
          lastSpeaker = speaker;
          if (nextPeer) {
            const idx = activePeers.indexOf(nextPeer);
            if (idx >= 0) turnIdx = idx;
          }
        } catch (err) {
          this.emit({
            type: 'system',
            level: 'warn',
            text: `${speaker.name} trailed off mid-sentence (${speaker.llm.label}): ${truncate((err as Error).message, 200)}`,
          });
          break;
        }
      }
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          group[i]!.relationship(group[j]!.name).interactions++;
          group[j]!.relationship(group[i]!.name).interactions++;
        }
      }
      for (const p of group) {
        p.acknowledgeConversation(lines);
        p.lastActedTick = this.tick;
        const othersNames = group.filter((o) => o !== p).map((o) => o.name);
        p.activity = `just finished chatting with ${othersNames.join(' & ')}`;
        if (p !== a) this.emit({ type: 'mood', who: p.name, mood: p.mood, energy: Math.round(p.energy), activity: p.activity });
      }
    } finally {
      for (const p of group) {
        p.inConversation = false;
        p.anchor = undefined;
      }
    }
  }

  /** Emits a spoken line and lets everyone in the room hear it. */
  private say(speaker: Resident, to: string, text: string, conversationId?: string): void {
    const now = this.clock.now;
    this.emit({ type: 'say', room: speaker.room, who: speaker.name, to, text, conversationId });
    speaker.remember('conversation', `I said to ${to}: "${text}"`, 4, now, this.tick, [to]);
    for (const o of this.awakeIn(speaker.room, speaker)) {
      if (o.name === to) o.perceive(`${speaker.name} said to you: "${text}"`, 5, now, this.tick, [speaker.name], 'conversation');
      else o.perceive(`${speaker.name} said to ${to}: "${text}"`, 3, now, this.tick, [speaker.name, to], 'conversation');
    }
  }

  private async handleMove(r: Resident, action: Action): Promise<void> {
    const room = this.house.resolve(action.target) ?? this.house.resolve(action.content);
    if (!room || room.id === r.room) {
      await this.handleDo(r, action.content || 'looking around the room');
      return;
    }
    const obj = this.house.matchObject(room.id, action.content);
    const dest = (obj && this.house.standSpot(obj, r.pos)) ?? this.house.grid.randomFloor(this.house.index(room.id));
    if (!dest) {
      await this.handleDo(r, action.content || 'looking around the room');
      return;
    }
    const text = action.content || `heading to the ${room.name}`;
    r.anchor = undefined;
    r.activity = text;
    const arrived = await this.walkTo(r, dest, room.id, 'move', text);
    if (arrived && obj) this.settleAt(r, obj, dest);
  }

  private async handleDo(r: Resident, content: string): Promise<void> {
    const now = this.clock.now;
    const text = content || 'pottering about';
    const obj = this.house.matchObject(r.room, text);
    r.anchor = undefined;
    if (obj) {
      const spot = this.house.standSpot(obj, r.pos);
      if (spot) {
        const arrived = sameTile(spot, r.pos) || (await this.walkTo(r, spot, r.room, 'object'));
        if (!arrived) return;
        this.settleAt(r, obj, spot);
      }
    } else if (chance(0.5)) {
      const spot = this.house.grid.randomFloor(this.house.index(r.room), { near: r.pos, radius: 5 });
      if (spot && !(await this.walkTo(r, spot, r.room, 'object'))) return;
    }
    r.activity = text;
    this.emit({ type: 'do', room: r.room, who: r.name, text });
    r.remember('action', `I was ${text}.`, 2, now, this.tick);
    for (const o of this.awakeIn(r.room, r)) o.perceive(`${r.name} is ${text}.`, 1, now, this.tick, [r.name]);
  }

  private async handleRest(r: Resident, action: Action): Promise<void> {
    const now = this.clock.now;
    const text = action.content || 'resting with eyes closed';
    r.anchor = undefined;
    const seat = this.house.matchObject(r.room, text) ?? this.house.nearestOfKind(r.room, SEATS, r.pos)[0];
    if (seat) {
      const spot = this.house.standSpot(seat, r.pos);
      if (spot) {
        const arrived = sameTile(spot, r.pos) || (await this.walkTo(r, spot, r.room, 'object'));
        if (!arrived) return;
        this.settleAt(r, seat, spot);
      }
    }
    r.activity = text;
    r.energy = clamp(r.energy + 6, 0, 100);
    this.emit({ type: 'rest', room: r.room, who: r.name, text });
    r.remember('action', `I rested: ${text}.`, 1, now, this.tick);
    for (const o of this.awakeIn(r.room, r)) o.perceive(`${r.name} is ${text}.`, 1, now, this.tick, [r.name]);
  }

  /** Stay put at an object and turn toward it (or away from the wall when sitting on it). */
  private settleAt(r: Resident, obj: PlacedObject, spot: Tile): void {
    r.anchor = { ...spot };
    const onIt = spot.x >= obj.x && spot.x < obj.x + obj.w && spot.y >= obj.y && spot.y < obj.y + obj.h;
    const facing: Facing = onIt ? obj.facing : facingToward(spot, centerOf(obj));
    if (facing !== r.facing) {
      r.facing = facing;
      this.emitPos(r);
    }
  }

  private async planDay(r: Resident): Promise<void> {
    const now = this.clock.now;
    const { plan } = await r.makePlan(now);
    if (!this.residents.includes(r)) return;
    this.emit({ type: 'plan', who: r.name, plan });
    r.remember('plan', `My plan for Day ${now.day}: ${plan.map((p) => `${p.time} ${p.activity}`).join('; ')}.`, 4, now, this.tick);
  }

  private async reflect(r: Resident): Promise<void> {
    const now = this.clock.now;
    const { insights, goalChanges } = await r.reflect(now);
    if (!this.residents.includes(r)) return;
    for (const i of insights) r.remember('reflection', i, 8, now, this.tick);
    if (insights.length) this.emit({ type: 'reflection', who: r.name, insights });
    for (const g of goalChanges) {
      this.emit({ type: 'goal', who: r.name, goal: g.text, progress: g.progress, done: g.done });
    }
  }

  // ── the human guest ──────────────────────────────────────────────────────

  humanMove(roomRef: string): void {
    const room = this.house.resolve(roomRef);
    if (!room) return;
    const dest = this.house.grid.randomFloor(this.house.index(room.id));
    if (!dest) return;
    void this.walkTo(this.human, dest, room.id, 'visit');
    this.save();
  }

  /** Walk the guest to a specific tile (clicked on the map). */
  humanWalk(x: number, y: number): boolean {
    const t = { x: Math.round(x), y: Math.round(y) };
    if (!this.house.grid.canStand(t.x, t.y)) return false;
    const room = this.house.roomIdAt(t) ?? this.human.room;
    void this.walkTo(this.human, t, room, 'visit');
    return true;
  }

  async humanSay(text: string, to?: string): Promise<void> {
    const clean = text.trim().slice(0, 600);
    if (!clean) return;
    if (this.human.walk) this.movement.stop(this.human);
    const now = this.clock.now;
    const roomId = this.human.room;
    const room = this.house.get(roomId);
    const present = this.awakeIn(roomId);
    const target = to && to.toLowerCase() !== 'everyone' ? present.find((r) => r.name.toLowerCase() === to.toLowerCase()) : undefined;
    if (to && to.toLowerCase() !== 'everyone' && !target) {
      this.emit({ type: 'system', level: 'info', text: `${to} is not awake in this room to hear you.` });
      return;
    }
    const toName = target?.name ?? 'everyone';

    this.emit({ type: 'say', room: roomId, who: this.human.name, to: toName, text: clean, human: true });
    for (const r of present) {
      const addressed = r === target ? 'you' : toName;
      r.perceive(`${this.human.name} (a human guest) said to ${addressed}: "${clean}"`, 6, now, this.tick, [this.human.name], 'conversation');
    }
    if (present.length === 0) {
      const asleep = this.residents.filter((r) => r.room === roomId && !r.awake);
      this.emit({
        type: 'system',
        level: 'info',
        text: asleep.length
          ? `${asleep.map((r) => r.name).join(' and ')} ${asleep.length > 1 ? 'are' : 'is'} asleep and didn't hear you.`
          : `Nobody is in the ${room.name} to hear you.`,
      });
      return;
    }

    const potentiallyAvailable = (r: Resident): boolean => r.llm.mode === 'demo' || (r.llm.mode === 'live' && (r.llm.status === 'ready' || r.llm.status === 'unverified'));
    const responders = target ? [target] : present.filter(potentiallyAvailable).slice(0, 2);
    if (!responders.length || (target && !potentiallyAvailable(target))) {
      this.emit({
        type: 'system',
        level: 'warn',
        text: target
          ? `${target.name}'s model cannot answer right now (${target.llm.note ?? target.llm.status}).`
          : 'No resident here has an available model to answer. Connect a configured provider or explicitly choose a scripted demo in Studio.',
      });
      return;
    }
    for (const responder of responders) {
      await responder.guestLock.run(async () => {
        const free = await waitFor(() => !responder.busy && !responder.inConversation, 15_000);
        // The guest or resident may have moved while waiting for an autonomous turn.
        if (!free || !this.residents.includes(responder) || !responder.awake || responder.goingToBed || responder.room !== roomId || this.human.room !== roomId || !responder.llm.canComplete) {
          this.emit({ type: 'system', level: 'info', text: `${responder.name} is not available to answer in this room right now.` });
          return;
        }
        responder.busy = true;
        responder.inConversation = true;
        try {
          const lines = this.guestLines(responder.name);
          if (lines[lines.length - 1]?.text !== clean || lines[lines.length - 1]?.who !== this.human.name) lines.push({ who: this.human.name, text: clean });
          responder.anchor = undefined;
          const reached = await this.approach(responder, this.human);
          if (!reached || responder.room !== this.human.room) return;
          responder.anchor = { ...responder.pos };
          this.face(this.human, responder.pos);
          responder.activity = `talking with ${this.human.name}`;
          const reply = await responder.reply({
            now: this.clock.now,
            room: this.house.info(responder.room),
            partner: this.human.name,
            partnerIsHuman: true,
            participants: [this.human.name, ...responders.map((r) => r.name)],
            others: this.awakeIn(responder.room, responder).map((r) => r.name),
            lines,
            turnsLeft: 99,
          });
          if (reply.content && this.residents.includes(responder) && responder.room === this.human.room && responder.awake) {
            for (const peer of this.awakeIn(responder.room)) {
              this.guestLines(peer.name).push({ who: responder.name, text: reply.content });
            }
            if (reply.thought) this.emit({ type: 'thought', who: responder.name, text: reply.thought });
            this.say(responder, this.human.name, reply.content);
            responder.updateRelationship(this.human.name, reply.impression, reply.warmth);
            responder.acknowledgeConversation(lines);
          }
        } catch (err) {
          this.emit({
            type: 'system',
            level: 'warn',
            text: `${responder.name}'s model could not answer (${responder.llm.label}): ${truncate((err as Error).message, 200)}`,
          });
        } finally {
          responder.busy = false;
          responder.inConversation = false;
          responder.anchor = undefined;
          responder.activity = `just finished talking with ${this.human.name}`;
          responder.lastActedTick = this.tick;
          this.emit({ type: 'mood', who: responder.name, mood: responder.mood, energy: Math.round(responder.energy), activity: responder.activity });
          this.save();
        }
      });
    }
  }

  private guestLines(residentName: string): ConversationLine[] {
    let lines = this.guestConvos.get(residentName);
    if (!lines) {
      lines = [];
      this.guestConvos.set(residentName, lines);
    }
    if (lines.length > 12) lines.splice(0, lines.length - 12);
    return lines;
  }

  // ── queries ──────────────────────────────────────────────────────────────

  private presentFor(r: Resident): PresentPerson[] {
    const present: PresentPerson[] = this.residents
      .filter((o) => o !== r && o.room === r.room && !inTransit(o))
      .map((o) => ({ name: o.name, activity: o.awake ? o.activity : 'asleep' }));
    if (this.human.room === r.room && !inTransit(this.human)) present.push({ name: this.human.name, activity: 'visiting', human: true });
    return present;
  }

  private awakeIn(roomId: string, except?: Mover): Resident[] {
    return this.residents.filter((r) => r.room === roomId && r.awake && r !== except && !inTransit(r));
  }

  findResident(ref: string): Resident | undefined {
    const key = ref.trim().toLowerCase();
    if (!key) return undefined;
    return (
      this.residents.find((r) => r.name.toLowerCase() === key) ??
      this.residents.find((r) => key.includes(r.name.toLowerCase()))
    );
  }

  private isHumanName(ref: string): boolean {
    const key = ref.trim().toLowerCase();
    return !!key && (key === this.human.name.toLowerCase() || key.includes(this.human.name.toLowerCase()) || /guest|visitor/.test(key));
  }

  detail(name: string): ResidentDetail | undefined {
    return this.findResident(name)?.detail();
  }

  humanView(): HumanView {
    const h = this.human;
    return { name: h.name, emoji: h.emoji, color: h.color, look: h.look as Look, room: h.room, x: h.pos.x, y: h.pos.y, facing: h.facing, walk: walkView(h) };
  }

  snapshot(): Snapshot {
    return {
      house: {
        name: this.house.name,
        description: this.house.description,
        rooms: this.house.roomViews(),
        grid: this.house.gridView(),
        objects: this.house.objects,
      },
      editor: {
        residents: this.cfg.residents,
        objectKinds: Object.keys(KINDS),
      },
      serverTime: Date.now(),
      time: this.clock.now,
      tick: this.tick,
      running: this.running,
      speed: this.speed,
      residents: this.residents.map((r) => r.view()),
      human: this.humanView(),
      events: this.events.slice(-200),
      llm: { ...llmStats },
    };
  }

  // ── live house & resident studio ─────────────────────────────────────────

  saveResidentConfig(input: Partial<ResidentConfig> & { name: string }): void {
    const cleanName = input.name.trim();
    if (!cleanName) throw new Error('Resident name is required');
    let cfgEntry = this.cfg.residents.find((r) => r.name.toLowerCase() === cleanName.toLowerCase());
    const homeRoom = input.homeRoom && this.house.has(input.homeRoom) ? input.homeRoom : (cfgEntry?.homeRoom ?? this.house.rooms[0]!.id);
    const startRoom = input.startRoom && this.house.has(input.startRoom) ? input.startRoom : (cfgEntry?.startRoom ?? homeRoom);

    if (!cfgEntry) {
      cfgEntry = {
        name: cleanName,
        emoji: input.emoji || '🧑',
        color: input.color || '#6ec6ff',
        enabled: input.enabled ?? true,
        provider: input.provider || 'huggingface',
        model: input.model,
        age: input.age ?? 29,
        bio: input.bio || 'A new housemate getting settled in.',
        traits: Array.isArray(input.traits) && input.traits.length ? input.traits : ['curious', 'friendly'],
        style: input.style || 'Warm and conversational.',
        goals: Array.isArray(input.goals) && input.goals.length ? input.goals : ['get to know everyone in the house'],
        homeRoom,
        startRoom,
        wakeHour: input.wakeHour ?? 8,
        sleepHour: input.sleepHour ?? 23,
      };
      this.cfg.residents.push(cfgEntry);
    } else {
      Object.assign(cfgEntry, {
        ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.age !== undefined ? { age: input.age } : {}),
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        ...(Array.isArray(input.traits) ? { traits: input.traits } : {}),
        ...(input.style !== undefined ? { style: input.style } : {}),
        ...(Array.isArray(input.goals) ? { goals: input.goals } : {}),
        homeRoom,
        startRoom,
        ...(input.wakeHour !== undefined ? { wakeHour: input.wakeHour } : {}),
        ...(input.sleepHour !== undefined ? { sleepHour: input.sleepHour } : {}),
      });
    }

    const existingIdx = this.residents.findIndex((r) => r.name.toLowerCase() === cleanName.toLowerCase());
    if (cfgEntry.enabled === false) {
      if (existingIdx >= 0) {
        const removed = this.residents[existingIdx]!;
        if (this.residents.length <= 1) {
          cfgEntry.enabled = true;
          throw new Error('At least one resident must stay in the house.');
        }
        const t = this.brainTimers.get(removed.name);
        if (t) clearTimeout(t);
        this.brainTimers.delete(removed.name);
        if (removed.walk) this.movement.stop(removed);
        this.residents.splice(existingIdx, 1);
        this.assignBeds();
        this.emit({ type: 'system', level: 'info', text: `${removed.cfg.emoji} ${removed.name} packed their bag and moved out for a while.` });
      }
      this.save();
      return;
    }

    const llm = this.clientFor(cfgEntry);
    if (existingIdx >= 0) {
      const r = this.residents[existingIdx]!;
      r.updateConfig(cfgEntry, llm);
      this.assignBeds();
      this.emit({ type: 'mood', who: r.name, mood: r.mood, energy: Math.round(r.energy), activity: r.activity });
      this.emit({ type: 'system', level: 'info', text: `Updated ${r.cfg.emoji} ${r.name}'s profile.` });
    } else {
      const r = new Resident(cfgEntry, llm, this.worldInfo, this.cfg.memory);
      if (r.shouldSleepAt(this.clock.time.hour)) {
        r.awake = false;
        r.room = cfgEntry.homeRoom;
        r.activity = 'sleeping';
      }
      this.residents.push(r);
      this.assignBeds();
      this.placeInitially(r, false);
      if (this.running) this.scheduleBrain(r, 2500);
      this.emit({ type: 'system', level: 'info', text: `${r.cfg.emoji} ${r.name} just moved into the ${this.house.nameOf(r.room)}!` });
    }
    this.save();
  }

  updateRoomObjects(
    roomId: string,
    action: 'add' | 'remove' | 'description',
    payload: { object?: ObjectConfig; index?: number; description?: string },
  ): void {
    const roomCfg = this.cfg.rooms.find((r) => r.id === roomId);
    if (!roomCfg) throw new Error(`Unknown room "${roomId}"`);
    const prevObjects = [...roomCfg.objects];
    const prevDesc = roomCfg.description;

    try {
      if (action === 'description' && typeof payload.description === 'string') {
        roomCfg.description = payload.description.trim() || roomCfg.description;
      } else if (action === 'add' && payload.object) {
        roomCfg.objects.push(payload.object);
      } else if (action === 'remove' && typeof payload.index === 'number') {
        if (payload.index < 0 || payload.index >= roomCfg.objects.length) throw new Error('Invalid object index');
        roomCfg.objects.splice(payload.index, 1);
      } else {
        throw new Error('Invalid room update action');
      }

      const nextHouse = new House(this.cfg);
      this.house = nextHouse;
      this.worldInfo.roomsDescription = this.house.describeAll();
      this.worldInfo.roomIds = this.house.rooms.map((r) => r.id);
      this.assignBeds();
      for (const m of this.movers()) {
        if (!this.house.grid.canStand(m.pos.x, m.pos.y)) {
          const fallback = this.house.grid.randomFloor(this.house.index(m.room));
          if (fallback) {
            m.pos = fallback;
            this.emitPos(m);
          }
        }
      }
      this.save();
    } catch (err) {
      roomCfg.objects = prevObjects;
      roomCfg.description = prevDesc;
      throw err;
    }
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private save(): void {
    if (!this.store) return;
    this.store.save(this.toSaved());
  }

  flush(): void {
    if (!this.store) return;
    this.store.save(this.toSaved());
    this.store.flush();
  }

  private toSaved(): SavedState {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      time: this.clock.now,
      tick: this.tick,
      human: { name: this.human.name, room: this.human.room },
      residents: this.residents.map((r) => r.snapshot()),
      events: this.events.slice(-200),
    };
  }
}

function normaliseLine(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
