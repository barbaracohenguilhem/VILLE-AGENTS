import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Loads .env from the project root (if present) using Node's built-in loader. */
export function loadEnv(rootDir: string): void {
  const file = resolve(rootDir, '.env');
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    console.warn(`[env] could not load ${file}: ${(err as Error).message}`);
  }
}

export function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}
