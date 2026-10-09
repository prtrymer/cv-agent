import { parseRetryAfter, sleep, withRetry } from './retry.js';

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly retryAfterMs?: number) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export interface HttpOptions { userAgent: string; timeoutMs: number; minIntervalMsPerHost: number; maxBytes: number; retries?: number }
export interface FetchResult { status: number; text: string; etag: string | null; lastModified: string | null; notModified: boolean }

const lastHit = new Map<string, number>();

export function isRetryableHttp(e: unknown): boolean {
  if (e instanceof HttpError) return [408, 425, 429, 500, 502, 503, 504].includes(e.status);
  const name = (e as Error | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError' || name === 'TypeError';
}

/** GET with a per-host minimum interval, hard timeout, size cap, retries and conditional requests. */
export async function politeFetch(url: string, o: HttpOptions, cond: { etag?: string | null; lastModified?: string | null } = {}): Promise<FetchResult> {
  const host = new URL(url).host;
  return withRetry(async () => {
    const wait = (lastHit.get(host) ?? 0) + o.minIntervalMsPerHost - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    const headers: Record<string, string> = { 'user-agent': o.userAgent, accept: 'application/rss+xml, application/xml, text/html;q=0.9, */*;q=0.5' };
    if (cond.etag) headers['if-none-match'] = cond.etag;
    if (cond.lastModified) headers['if-modified-since'] = cond.lastModified;
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(o.timeoutMs) });
    if (res.status === 304) return { status: 304, text: '', etag: cond.etag ?? null, lastModified: cond.lastModified ?? null, notModified: true };
    if (!res.ok) throw new HttpError(res.status, url, parseRetryAfter(res.headers.get('retry-after')));
    return { status: res.status, text: await readCapped(res, o.maxBytes), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), notModified: false };
  }, { retries: o.retries ?? 3, isRetryable: isRetryableHttp, retryAfterMs: (e) => (e instanceof HttpError ? e.retryAfterMs : undefined) });
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new Error(`response larger than ${max} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
