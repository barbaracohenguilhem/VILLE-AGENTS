export function pick<T>(arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('pick() from empty array');
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

export function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function chance(p: number): boolean {
  return Math.random() < p;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

let counter = 0;
export function uid(prefix = 'e'): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Serialises async work so only one task runs at a time. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Limits how many async tasks run concurrently. */
export class Semaphore {
  max: number;
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** Polls `pred` until it is true or the timeout passes; resolves with the final value. */
export async function waitFor(pred: () => boolean, timeoutMs: number, everyMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }
  return true;
}
