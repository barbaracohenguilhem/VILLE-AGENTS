import type { Facing, Look, Tile, WalkPurpose, WalkView } from '../types.ts';
import { facingToward } from './grid.ts';

export interface Walk {
  path: Tile[];
  startedAt: number;
  tileMs: number;
  fromRoom: string;
  toRoom: string;
  purpose: WalkPurpose;
  text: string;
  /** Index into `path` of the tile the mover currently occupies. */
  index: number;
  resolve: (arrived: boolean) => void;
}

/** Anything that has a body on the map: residents and the human guest. */
export interface Mover {
  readonly name: string;
  readonly isHuman: boolean;
  readonly look: Look;
  pos: Tile;
  facing: Facing;
  room: string;
  walk: Walk | undefined;
}

/** True while walking from one room to another (not yet "present" anywhere). */
export function inTransit(m: Mover): boolean {
  return !!m.walk && m.walk.toRoom !== m.room;
}

export function walkView(m: Mover, now = Date.now()): WalkView | undefined {
  const w = m.walk;
  if (!w) return undefined;
  return { path: w.path, tileMs: w.tileMs, elapsed: now - w.startedAt, toRoom: w.toRoom, purpose: w.purpose };
}

export interface MovementHooks {
  onWalk(m: Mover, walk: Walk): void;
  onArrive(m: Mover, walk: Walk): void;
  onStop(m: Mover, walk: Walk): void;
}

/**
 * Advances movers along their paths in real time. Positions are a function of
 * elapsed time so the browser can animate the same path independently.
 */
export class Movement {
  private readonly hooks: MovementHooks;

  constructor(hooks: MovementHooks) {
    this.hooks = hooks;
  }

  start(m: Mover, path: Tile[], opts: { tileMs: number; toRoom: string; purpose: WalkPurpose; text: string }): Promise<boolean> {
    if (m.walk) this.stop(m);
    return new Promise<boolean>((resolve) => {
      const walk: Walk = {
        path,
        startedAt: Date.now(),
        tileMs: opts.tileMs,
        fromRoom: m.room,
        toRoom: opts.toRoom,
        purpose: opts.purpose,
        text: opts.text,
        index: 0,
        resolve,
      };
      m.walk = walk;
      const next = path[1];
      if (next) m.facing = facingToward(path[0] ?? m.pos, next);
      this.hooks.onWalk(m, walk);
    });
  }

  stop(m: Mover): void {
    const w = m.walk;
    if (!w) return;
    m.walk = undefined;
    this.hooks.onStop(m, w);
    w.resolve(false);
  }

  advance(m: Mover, now: number): void {
    const w = m.walk;
    if (!w) return;
    const last = w.path.length - 1;
    const elapsed = now - w.startedAt;
    const idx = Math.min(last, Math.floor(elapsed / w.tileMs));
    if (idx > w.index) {
      for (let i = w.index + 1; i <= idx; i++) {
        const prev = w.path[i - 1];
        const cur = w.path[i];
        if (prev && cur) m.facing = facingToward(prev, cur);
      }
      w.index = idx;
      const here = w.path[idx];
      if (here) m.pos = { ...here };
    }
    if (elapsed >= last * w.tileMs) {
      const end = w.path[last];
      if (end) m.pos = { ...end };
      m.walk = undefined;
      this.hooks.onArrive(m, w);
      w.resolve(true);
    }
  }
}

const SKIN = ['#f3cfa8', '#e8b98a', '#d39b6b', '#b57a4c', '#8c5a34', '#5e3b22'];
const HAIR = ['#2a1a12', '#5a3a26', '#b5542f', '#d9a441', '#1b1b1f', '#8a8a92', '#c94f7c', '#3b6ea5', '#f0e2c0'];
const PANTS = ['#2f3a5a', '#3a3a3f', '#5a4632', '#243b2f', '#4a2d4a', '#6b6b73'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Fills in sprite colours not set in the config, deterministically from the name. */
export function makeLook(name: string, shirt: string, partial?: Partial<Look>): Look {
  const h = hash(name);
  return {
    skin: partial?.skin ?? (SKIN[h % SKIN.length] as string),
    hair: partial?.hair ?? (HAIR[(h >>> 8) % HAIR.length] as string),
    pants: partial?.pants ?? (PANTS[(h >>> 16) % PANTS.length] as string),
    shirt: partial?.shirt ?? shirt,
  };
}
