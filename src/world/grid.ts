import { CELL, type Facing, type PlacedObject, type RoomConfig, type Tile } from '../types.ts';
import { pick } from '../util/random.ts';

const DIRS: readonly Tile[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

export function sameTile(a: Tile, b: Tile): boolean {
  return a.x === b.x && a.y === b.y;
}

export function manhattan(a: Tile, b: Tile): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function chebyshev(a: Tile, b: Tile): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function facingToward(from: Tile, to: Tile): Facing {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

export function centerOf(o: { x: number; y: number; w: number; h: number }): Tile {
  return { x: o.x + (o.w - 1) / 2, y: o.y + (o.h - 1) / 2 };
}

/**
 * The walkable map of the house. Room interiors come from the config; walls,
 * fences and doors are generated around and between them.
 */
export class Grid {
  readonly width: number;
  readonly height: number;
  /** Room index (>= 0) or a CELL code. */
  readonly cells: Int16Array;
  readonly blocked: Uint8Array;
  readonly sit: Uint8Array;
  readonly doors: Tile[] = [];
  private readonly rooms: RoomConfig[];

  constructor(rooms: RoomConfig[], objects: PlacedObject[]) {
    this.rooms = rooms;
    let width = 0;
    let height = 0;
    for (const r of rooms) {
      if (r.x < 1 || r.y < 1) throw new Error(`room "${r.id}": x and y must be at least 1 to leave space for walls`);
      if (r.w < 2 || r.h < 2) throw new Error(`room "${r.id}": rooms must be at least 2×2 tiles`);
      width = Math.max(width, r.x + r.w + 1);
      height = Math.max(height, r.y + r.h + 1);
    }
    if (width > 200 || height > 200) throw new Error('the house is too big (max 200×200 tiles)');
    this.width = width;
    this.height = height;
    this.cells = new Int16Array(width * height).fill(CELL.VOID);
    this.blocked = new Uint8Array(width * height);
    this.sit = new Uint8Array(width * height);

    rooms.forEach((r, i) => {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const idx = this.idx(x, y);
          const existing = this.cells[idx] ?? CELL.VOID;
          if (existing >= 0) throw new Error(`rooms "${rooms[existing]?.id}" and "${r.id}" overlap at ${x},${y}`);
          this.cells[idx] = i;
        }
      }
    });

    this.buildWalls();
    this.carveDoors();

    for (const o of objects) {
      for (let y = o.y; y < o.y + o.h; y++) {
        for (let x = o.x; x < o.x + o.w; x++) {
          if (!this.inBounds(x, y)) continue;
          const idx = this.idx(x, y);
          if (o.blocking) this.blocked[idx] = 1;
          if (o.sit) this.sit[idx] = 1;
        }
      }
    }
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i] ?? CELL.VOID;
      if (c < 0 && c !== CELL.DOOR) this.blocked[i] = 1;
    }
  }

  // ── structure ────────────────────────────────────────────────────────────

  private buildWalls(): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.cells[this.idx(x, y)] !== CELL.VOID) continue;
        let touchesRoom = false;
        let touchesIndoor = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const r = this.roomAt(x + dx, y + dy);
            if (r >= 0) {
              touchesRoom = true;
              if (!this.rooms[r]?.outdoor) touchesIndoor = true;
            }
          }
        }
        if (touchesRoom) this.cells[this.idx(x, y)] = touchesIndoor ? CELL.WALL : CELL.FENCE;
      }
    }
  }

  /** Opens a doorway in the middle of every wall segment shared by two rooms. */
  private carveDoors(): void {
    const groups = new Map<string, Tile[]>();
    const add = (a: number, b: number, orient: string, t: Tile) => {
      const key = `${Math.min(a, b)}:${Math.max(a, b)}:${orient}`;
      let list = groups.get(key);
      if (!list) {
        list = [];
        groups.set(key, list);
      }
      list.push(t);
    };
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = this.cells[this.idx(x, y)];
        if (c !== CELL.WALL && c !== CELL.FENCE) continue;
        const l = this.roomAt(x - 1, y);
        const r = this.roomAt(x + 1, y);
        if (l >= 0 && r >= 0 && l !== r) add(l, r, 'h', { x, y });
        const u = this.roomAt(x, y - 1);
        const d = this.roomAt(x, y + 1);
        if (u >= 0 && d >= 0 && u !== d) add(u, d, 'v', { x, y });
      }
    }
    for (const tiles of groups.values()) {
      tiles.sort((a, b) => a.x + a.y - (b.x + b.y));
      const mid = Math.floor((tiles.length - 1) / 2);
      const chosen = tiles.length >= 4 ? [tiles[mid], tiles[mid + 1]] : [tiles[mid]];
      for (const t of chosen) {
        if (!t) continue;
        this.cells[this.idx(t.x, t.y)] = CELL.DOOR;
        this.doors.push(t);
      }
    }
  }

  // ── queries ──────────────────────────────────────────────────────────────

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  cell(x: number, y: number): number {
    return this.inBounds(x, y) ? (this.cells[this.idx(x, y)] ?? CELL.VOID) : CELL.VOID;
  }

  roomAt(x: number, y: number): number {
    const c = this.cell(x, y);
    return c >= 0 ? c : -1;
  }

  isFloor(x: number, y: number): boolean {
    const c = this.cell(x, y);
    return c >= 0 || c === CELL.DOOR;
  }

  isWalkable(x: number, y: number): boolean {
    return this.isFloor(x, y) && !this.blocked[this.idx(x, y)];
  }

  /** Walkable, or a sit tile (allowed as a destination but not as a thoroughfare). */
  canStand(x: number, y: number): boolean {
    return this.isFloor(x, y) && (!this.blocked[this.idx(x, y)] || !!this.sit[this.idx(x, y)]);
  }

  /** Room ids that cannot be reached from the first room. */
  unreachableRooms(): string[] {
    const first = this.rooms[0];
    if (!first) return [];
    const start = this.randomFloor(0);
    if (!start) return this.rooms.slice(1).map((r) => r.id);
    const seen = new Uint8Array(this.cells.length);
    const reachedRooms = new Set<number>();
    const stack: Tile[] = [start];
    seen[this.idx(start.x, start.y)] = 1;
    while (stack.length) {
      const t = stack.pop() as Tile;
      const room = this.roomAt(t.x, t.y);
      if (room >= 0) reachedRooms.add(room);
      for (const d of DIRS) {
        const nx = t.x + d.x;
        const ny = t.y + d.y;
        if (!this.inBounds(nx, ny) || seen[this.idx(nx, ny)] || !this.isWalkable(nx, ny)) continue;
        seen[this.idx(nx, ny)] = 1;
        stack.push({ x: nx, y: ny });
      }
    }
    return this.rooms.filter((_, i) => !reachedRooms.has(i)).map((r) => r.id);
  }

  // ── placement helpers ────────────────────────────────────────────────────

  randomFloor(roomIndex: number, opts: { near?: Tile; radius?: number; allowSit?: boolean } = {}): Tile | undefined {
    const r = this.rooms[roomIndex];
    if (!r) return undefined;
    const collect = (withNear: boolean): Tile[] => {
      const out: Tile[] = [];
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (this.roomAt(x, y) !== roomIndex) continue;
          const idx = this.idx(x, y);
          if (this.blocked[idx] && !(opts.allowSit && this.sit[idx])) continue;
          if (!opts.allowSit && this.sit[idx]) continue;
          if (withNear && opts.near && chebyshev(opts.near, { x, y }) > (opts.radius ?? 3)) continue;
          if (withNear && opts.near && sameTile(opts.near, { x, y })) continue;
          out.push({ x, y });
        }
      }
      return out;
    };
    let tiles = collect(!!opts.near);
    if (tiles.length === 0 && opts.near) tiles = collect(false);
    return tiles.length ? pick(tiles) : undefined;
  }

  /** A standable tile next to `target`, as close to `from` as possible. */
  closestStand(target: Tile, from: Tile, maxRadius = 2): Tile | undefined {
    for (let radius = 1; radius <= maxRadius; radius++) {
      let best: Tile | undefined;
      let bestScore = Infinity;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const t = { x: target.x + dx, y: target.y + dy };
          if (!this.canStand(t.x, t.y)) continue;
          // Prefer orthogonal neighbours (face to face) and avoid standing in doorways.
          const score = manhattan(t, from) + (dx && dy ? 0.5 : 0) + (this.cell(t.x, t.y) === CELL.DOOR ? 3 : 0);
          if (score < bestScore) {
            bestScore = score;
            best = t;
          }
        }
      }
      if (best) return best;
    }
    return undefined;
  }

  /**
   * Where to stand to use an object: on it if it's a seat (unless `beside`),
   * otherwise in front of it. Seats are preferred, then the front, then the sides.
   */
  standSpots(o: PlacedObject, opts: { beside?: boolean } = {}): Tile[] {
    if (o.sit && !opts.beside) {
      const on: Tile[] = [];
      for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) if (this.canStand(x, y)) on.push({ x, y });
      if (on.length) return on;
    }
    const front: Tile[] = [];
    const sides: Tile[] = [];
    for (let y = o.y - 1; y <= o.y + o.h; y++) {
      for (let x = o.x - 1; x <= o.x + o.w; x++) {
        const insideX = x >= o.x && x < o.x + o.w;
        const insideY = y >= o.y && y < o.y + o.h;
        if (insideX === insideY) continue; // skip the footprint itself and diagonal corners
        if (!this.canStand(x, y) || this.roomAt(x, y) < 0) continue;
        const isFront =
          (o.facing === 'down' && y === o.y + o.h) ||
          (o.facing === 'up' && y === o.y - 1) ||
          (o.facing === 'left' && x === o.x - 1) ||
          (o.facing === 'right' && x === o.x + o.w);
        (isFront ? front : sides).push({ x, y });
      }
    }
    const isSit = (t: Tile) => !!this.sit[this.idx(t.x, t.y)];
    return [...front.filter(isSit), ...sides.filter(isSit), ...front.filter((t) => !isSit(t)), ...sides.filter((t) => !isSit(t))];
  }

  // ── pathfinding ──────────────────────────────────────────────────────────

  /** A* over 4-connected tiles. The goal may be a sit tile; intermediate tiles must be walkable. */
  findPath(from: Tile, to: Tile): Tile[] | null {
    if (!this.inBounds(from.x, from.y) || !this.canStand(to.x, to.y)) return null;
    if (sameTile(from, to)) return [{ ...from }];
    const n = this.cells.length;
    const start = this.idx(from.x, from.y);
    const goal = this.idx(to.x, to.y);
    const g = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const open = new MinHeap();
    g[start] = 0;
    open.push(start, manhattan(from, to));

    while (open.size > 0) {
      const cur = open.pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % this.width;
      const cy = Math.floor(cur / this.width);
      for (const d of DIRS) {
        const nx = cx + d.x;
        const ny = cy + d.y;
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (ni !== goal && !this.isWalkable(nx, ny)) continue;
        const ng = (g[cur] ?? Infinity) + 1;
        if (ng < (g[ni] ?? Infinity)) {
          g[ni] = ng;
          came[ni] = cur;
          open.push(ni, ng + Math.abs(nx - to.x) + Math.abs(ny - to.y));
        }
      }
    }
    if (came[goal] === -1) return null;
    const path: Tile[] = [];
    for (let i = goal; i !== -1; i = came[i] ?? -1) {
      path.push({ x: i % this.width, y: Math.floor(i / this.width) });
      if (i === start) break;
    }
    path.reverse();
    return path;
  }
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(val: number, key: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.keys[p] as number) <= (this.keys[i] as number)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.vals[0] as number;
    const lastKey = this.keys.pop() as number;
    const lastVal = this.vals.pop() as number;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && (this.keys[l] as number) < (this.keys[m] as number)) m = l;
        if (r < this.keys.length && (this.keys[r] as number) < (this.keys[m] as number)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a] as number;
    this.keys[a] = this.keys[b] as number;
    this.keys[b] = k;
    const v = this.vals[a] as number;
    this.vals[a] = this.vals[b] as number;
    this.vals[b] = v;
  }
}
