import type { FloorStyle, GridView, HouseConfig, ObjectConfig, PlacedObject, RoomConfig, RoomView, Tile } from '../types.ts';
import { Grid } from './grid.ts';

interface KindSpec {
  w: number;
  h: number;
  blocking: boolean;
  sit?: boolean;
}

/** Every furniture kind the renderer knows how to draw, with its default footprint. */
export const KINDS: Record<string, KindSpec> = {
  sofa: { w: 3, h: 1, blocking: true, sit: true },
  armchair: { w: 1, h: 1, blocking: true, sit: true },
  bench: { w: 2, h: 1, blocking: true, sit: true },
  chair: { w: 1, h: 1, blocking: true, sit: true },
  beanbag: { w: 1, h: 1, blocking: true, sit: true },
  bed: { w: 1, h: 2, blocking: true, sit: true },
  table: { w: 2, h: 1, blocking: true },
  coffeetable: { w: 2, h: 1, blocking: true },
  desk: { w: 2, h: 1, blocking: true },
  deskpc: { w: 2, h: 1, blocking: true },
  shelf: { w: 2, h: 1, blocking: true },
  counter: { w: 1, h: 1, blocking: true },
  'counter-coffee': { w: 1, h: 1, blocking: true },
  'counter-bowl': { w: 1, h: 1, blocking: true },
  'counter-radio': { w: 1, h: 1, blocking: true },
  stove: { w: 1, h: 1, blocking: true },
  sink: { w: 1, h: 1, blocking: true },
  fridge: { w: 1, h: 1, blocking: true },
  tv: { w: 2, h: 1, blocking: true },
  fireplace: { w: 2, h: 1, blocking: true },
  records: { w: 2, h: 1, blocking: true },
  board: { w: 1, h: 1, blocking: true },
  games: { w: 1, h: 1, blocking: true },
  plant: { w: 1, h: 1, blocking: true },
  tree: { w: 2, h: 2, blocking: true },
  planter: { w: 3, h: 1, blocking: true },
  can: { w: 1, h: 1, blocking: true },
  bin: { w: 1, h: 1, blocking: true },
  chess: { w: 1, h: 1, blocking: true },
  lamp: { w: 1, h: 1, blocking: true },
  globe: { w: 1, h: 1, blocking: true },
  books: { w: 1, h: 1, blocking: true },
  easel: { w: 1, h: 1, blocking: true },
  canvases: { w: 2, h: 1, blocking: true },
  keyboard: { w: 3, h: 1, blocking: true },
  guitar: { w: 1, h: 1, blocking: true },
  speaker: { w: 1, h: 1, blocking: true },
  basket: { w: 1, h: 1, blocking: true },
  mirror: { w: 1, h: 1, blocking: true },
  telescope: { w: 1, h: 1, blocking: true },
  box: { w: 1, h: 1, blocking: true },
  // flat decor — walked over
  rug: { w: 3, h: 2, blocking: false },
  mat: { w: 1, h: 1, blocking: false },
  splat: { w: 1, h: 1, blocking: false },
  flowers: { w: 1, h: 1, blocking: false },
  stones: { w: 1, h: 1, blocking: false },
  lights: { w: 3, h: 1, blocking: false },
};

export const FLAT_KINDS = new Set(Object.entries(KINDS).filter(([, k]) => !k.blocking).map(([id]) => id));

export interface RoomInfo {
  id: string;
  name: string;
  description: string;
  objects: string[];
}

/** Flat decor that would only clutter the residents' view of a room. */
const PROMPT_HIDDEN = new Set(['rug', 'mat', 'splat', 'stones']);

const NAME_STOP = new Set(['the', 'and', 'with', 'of', 'a', 'an', 'in', 'on', 'to', 'old', 'big', 'small', 'long']);

function stem(word: string): string {
  return word.replace(/(ies|es|s)$/, (m) => (m === 'ies' ? 'y' : ''));
}

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z'-]{1,}/g) ?? []) {
    if (!NAME_STOP.has(w)) out.add(stem(w));
  }
  return out;
}

export class House {
  readonly name: string;
  readonly description: string;
  readonly rooms: RoomConfig[];
  readonly objects: PlacedObject[] = [];
  readonly grid: Grid;
  private byId = new Map<string, RoomConfig>();
  private byName = new Map<string, RoomConfig>();
  private indexOf = new Map<string, number>();
  private objectsByRoom = new Map<string, PlacedObject[]>();

  constructor(cfg: HouseConfig) {
    this.name = cfg.name;
    this.description = cfg.description;
    if (cfg.rooms.length === 0) throw new Error('house.json needs at least one room');
    this.rooms = cfg.rooms.map((r) => ({
      ...r,
      floor: r.floor ?? (r.outdoor ? 'grass' : 'wood'),
      outdoor: !!r.outdoor,
      objects: r.objects ?? [],
    }));
    this.rooms.forEach((r, i) => {
      if (this.byId.has(r.id.toLowerCase())) throw new Error(`duplicate room id "${r.id}"`);
      this.byId.set(r.id.toLowerCase(), r);
      this.byName.set(r.name.toLowerCase(), r);
      this.indexOf.set(r.id, i);
      this.objectsByRoom.set(r.id, []);
    });

    // First pass: the bare structure, so auto-placed objects can avoid doorways.
    const bare = new Grid(this.rooms, []);
    const placed: PlacedObject[] = [];
    const pending: { room: RoomConfig; obj: ObjectConfig }[] = [];
    for (const room of this.rooms) {
      room.objects.forEach((o, i) => {
        if (typeof o === 'string') pending.push({ room, obj: { name: o, kind: 'box' } });
        else if (o.x === undefined || o.y === undefined) pending.push({ room, obj: o });
        else placed.push(this.place(room, o, i));
      });
    }
    for (const p of pending) placed.push(this.autoPlace(p.room, p.obj, placed, bare));
    for (const o of placed) {
      this.objects.push(o);
      this.objectsByRoom.get(o.room)?.push(o);
    }

    this.grid = new Grid(this.rooms, this.objects);
    const unreachable = this.grid.unreachableRooms();
    if (unreachable.length) {
      throw new Error(`rooms cannot be reached: ${unreachable.join(', ')} — rooms need to touch (with one wall tile between them) and doorways must not be blocked by furniture`);
    }
    for (const room of this.rooms) {
      if (!this.grid.randomFloor(this.indexOf.get(room.id) ?? 0)) throw new Error(`room "${room.id}" has no free floor left — remove some furniture`);
    }
  }

  private place(room: RoomConfig, o: ObjectConfig, i: number): PlacedObject {
    const kind = o.kind && KINDS[o.kind] ? o.kind : 'box';
    if (o.kind && !KINDS[o.kind]) console.warn(`[house] unknown object kind "${o.kind}" for "${o.name}" — drawing a box`);
    const spec = KINDS[kind] as KindSpec;
    const w = o.w ?? spec.w;
    const h = o.h ?? spec.h;
    const x = room.x + (o.x ?? 0);
    const y = room.y + (o.y ?? 0);
    if (x < room.x || y < room.y || x + w > room.x + room.w || y + h > room.y + room.h) {
      throw new Error(`"${o.name}" in ${room.id} does not fit inside the room (at ${o.x},${o.y} size ${w}×${h}; room is ${room.w}×${room.h})`);
    }
    return { id: `${room.id}:${i}`, name: o.name, kind, room: room.id, x, y, w, h, blocking: spec.blocking, sit: !!spec.sit, facing: o.facing ?? 'down' };
  }

  /** Puts an object without explicit coordinates against a wall or free floor, away from doors and other furniture. */
  private autoPlace(room: RoomConfig, o: ObjectConfig, placed: PlacedObject[], bare: Grid): PlacedObject {
    const kind = o.kind && KINDS[o.kind] ? o.kind : 'box';
    const spec = KINDS[kind] as KindSpec;
    const w = o.w ?? spec.w;
    const h = o.h ?? spec.h;
    const fitsAt = (rx: number, ry: number) => {
      if (rx < room.x || ry < room.y || rx + w > room.x + room.w || ry + h > room.y + room.h) return false;
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const tx = rx + dx;
          const ty = ry + dy;
          if (placed.some((p) => p.blocking && tx >= p.x && tx < p.x + p.w && ty >= p.y && ty < p.y + p.h)) return false;
          if (bare.doors.some((d) => Math.abs(d.x - tx) <= 1 && Math.abs(d.y - ty) <= 1)) return false;
        }
      }
      return true;
    };
    const edgeCandidates: Tile[] = [];
    const innerCandidates: Tile[] = [];
    for (let y = room.y; y <= room.y + room.h - h; y++) {
      for (let x = room.x; x <= room.x + room.w - w; x++) {
        if (!fitsAt(x, y)) continue;
        const edge = x === room.x || y === room.y || x + w === room.x + room.w || y + h === room.y + room.h;
        if (edge) edgeCandidates.push({ x, y });
        else innerCandidates.push({ x, y });
      }
    }
    const pool = edgeCandidates.length ? edgeCandidates : innerCandidates;
    const spot = pool[Math.floor(Math.random() * pool.length)] ?? { x: room.x, y: room.y };
    o.x = spot.x - room.x;
    o.y = spot.y - room.y;
    const i = placed.filter((p) => p.room === room.id).length;
    return {
      id: `${room.id}:auto${i}`,
      name: o.name,
      kind,
      room: room.id,
      x: spot.x,
      y: spot.y,
      w,
      h,
      blocking: spec.blocking,
      sit: !!spec.sit,
      facing: o.facing ?? 'down',
    };
  }

  // ── rooms ────────────────────────────────────────────────────────────────

  get(id: string): RoomConfig {
    const r = this.byId.get(id.toLowerCase());
    if (!r) throw new Error(`unknown room "${id}"`);
    return r;
  }

  has(id: string): boolean {
    return this.byId.has(id.toLowerCase());
  }

  index(id: string): number {
    return this.indexOf.get(id) ?? -1;
  }

  roomIdAt(t: Tile): string | undefined {
    const i = this.grid.roomAt(t.x, t.y);
    return i >= 0 ? this.rooms[i]?.id : undefined;
  }

  /** Resolves a model's loose reference ("Kitchen", "the kitchen", "kitchen") to a room. */
  resolve(ref: string): RoomConfig | undefined {
    const key = ref.trim().toLowerCase().replace(/^(the|to|into)\s+/, '').replace(/[.!]$/, '');
    if (!key) return undefined;
    const direct = this.byId.get(key) ?? this.byName.get(key);
    if (direct) return direct;
    for (const r of this.rooms) {
      if (key.includes(r.id.toLowerCase()) || key.includes(r.name.toLowerCase())) return r;
    }
    return undefined;
  }

  nameOf(id: string): string {
    return this.byId.get(id.toLowerCase())?.name ?? id;
  }

  info(id: string): RoomInfo {
    const r = this.get(id);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      objects: [...new Set(this.objectsIn(r.id).filter((o) => !PROMPT_HIDDEN.has(o.kind)).map((o) => o.name))],
    };
  }

  describeAll(): string {
    return this.rooms
      .map((r) => `- ${r.id} — ${r.name}: ${r.description} Things here: ${this.info(r.id).objects.join(', ') || 'nothing much'}.`)
      .join('\n');
  }

  // ── objects ──────────────────────────────────────────────────────────────

  objectsIn(roomId: string): PlacedObject[] {
    return this.objectsByRoom.get(roomId) ?? [];
  }

  /** Finds the object in a room that a free-text activity most plausibly refers to. */
  matchObject(roomId: string, text: string): PlacedObject | undefined {
    const tw = words(text);
    if (tw.size === 0) return undefined;
    let best: PlacedObject | undefined;
    let bestScore = 0;
    for (const o of this.objectsIn(roomId)) {
      const ow = words(o.name);
      ow.add(stem(o.kind.replace(/^counter-/, '')));
      let score = 0;
      for (const w of ow) if (tw.has(w)) score += w.length > 4 ? 2 : 1;
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best;
  }

  /** Objects of the given kinds in a room, nearest first. */
  nearestOfKind(roomId: string, kinds: string[], from: Tile): PlacedObject[] {
    return this.objectsIn(roomId)
      .filter((o) => kinds.includes(o.kind))
      .sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y));
  }

  /** The best tile from which to use an object, preferring seats, then spots close to `from`. */
  standSpot(o: PlacedObject, from?: Tile, opts: { beside?: boolean } = {}): Tile | undefined {
    const spots = this.grid.standSpots(o, opts);
    if (spots.length === 0) return undefined;
    if (!from) return spots[0];
    const score = (t: Tile, rank: number) => (this.grid.sit[this.grid.idx(t.x, t.y)] ? -10 : 0) + rank * 0.01 + Math.abs(t.x - from.x) + Math.abs(t.y - from.y);
    return spots.map((t, i) => ({ t, s: score(t, i) })).sort((a, b) => a.s - b.s)[0]?.t;
  }

  // ── views ────────────────────────────────────────────────────────────────

  roomViews(): RoomView[] {
    return this.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      emoji: r.emoji,
      color: r.color,
      description: r.description,
      floor: r.floor as FloorStyle,
      outdoor: !!r.outdoor,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
    }));
  }

  gridView(): GridView {
    return { width: this.grid.width, height: this.grid.height, cells: Array.from(this.grid.cells) };
  }
}
