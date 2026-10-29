import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ResidentSnapshot } from '../agents/resident.ts';
import type { SimTime, VilleEvent } from '../types.ts';

export interface SavedState {
  version: 1;
  savedAt: string;
  time: SimTime;
  tick: number;
  human: { name: string; room: string };
  residents: ResidentSnapshot[];
  events: VilleEvent[];
}

/** Persists the house to a JSON file so a restart picks up where it left off. */
export class Store {
  private readonly file: string;
  private timer: NodeJS.Timeout | undefined;
  private pending: SavedState | undefined;

  constructor(file: string) {
    this.file = file;
  }

  load(): SavedState | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as SavedState;
      if (data.version !== 1) return undefined;
      return data;
    } catch (err) {
      console.warn(`[store] ignoring unreadable ${this.file}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Debounced, atomic write. */
  save(state: SavedState): void {
    this.pending = state;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 1500);
  }

  flush(): void {
    if (!this.pending) return;
    const state = this.pending;
    this.pending = undefined;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[store] save failed: ${(err as Error).message}`);
    }
  }
}
