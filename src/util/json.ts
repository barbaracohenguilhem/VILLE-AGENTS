/**
 * Pulls a JSON object out of an LLM response that may be wrapped in prose or
 * markdown fences, and tolerates a few common syntax slips.
 */
export function extractJson<T = Record<string, unknown>>(raw: string): T {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`no JSON object found in response: ${truncate(raw, 160)}`);
  }
  const candidate = text.slice(start, end + 1);

  try {
    return JSON.parse(candidate) as T;
  } catch {
    const repaired = candidate
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\n/g, ' ');
    try {
      return JSON.parse(repaired) as T;
    } catch (err) {
      throw new Error(`invalid JSON in response (${(err as Error).message}): ${truncate(raw, 160)}`);
    }
  }
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export function str(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v.trim();
  if (v === null || v === undefined) return fallback;
  return String(v).trim();
}

export function bool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return /^(true|yes|1)$/i.test(v.trim());
  return fallback;
}
