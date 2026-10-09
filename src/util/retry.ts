export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  retries: number;
  baseMs?: number;
  capMs?: number;
  /** Give up once waiting would push total time past this. */
  deadlineMs?: number;
  isRetryable: (err: unknown) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Exponential backoff with full jitter; honours Retry-After (capped at 60s). */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  const base = o.baseMs ?? 500;
  const cap = o.capMs ?? 20_000;
  const rnd = o.random ?? Math.random;
  const wait = o.sleep ?? sleep;
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= o.retries || !o.isRetryable(err)) throw err;
      const backoff = Math.floor(rnd() * Math.min(cap, base * 2 ** attempt));
      const ra = o.retryAfterMs?.(err);
      const delay = ra !== undefined ? Math.min(Math.max(ra, backoff), 60_000) : backoff;
      if (o.deadlineMs !== undefined && Date.now() - started + delay > o.deadlineMs) throw err;
      o.onRetry?.(err, attempt + 1, delay);
      await wait(delay);
    }
  }
}

export function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}
