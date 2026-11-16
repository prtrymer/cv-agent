import type { Store } from '../store/db.js';
import type { Logger } from '../log.js';

export interface Cache {
  kind: 'redis' | 'sqlite';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  close(): Promise<void>;
}

/** Cache-aside store for LLM results. Redis when it's there, SQLite when it isn't — a cache failure never fails a run. */
export async function createCache(redisUrl: string | undefined, store: Store, log: Logger): Promise<Cache> {
  if (redisUrl) {
    try {
      const { Redis } = await import('ioredis');
      const r = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 1500, commandTimeout: 800, maxRetriesPerRequest: 1, enableOfflineQueue: false });
      r.on('error', () => { /* surfaced per operation below */ });
      await r.connect();
      log.info({ cache: 'redis' }, 'cache ready');
      return {
        kind: 'redis',
        get: async (k) => { try { return await r.get(k); } catch (e) { log.debug({ err: String(e) }, 'cache get failed'); return null; } },
        set: async (k, v, ttl) => { try { await r.set(k, v, 'EX', ttl); } catch (e) { log.debug({ err: String(e) }, 'cache set failed'); } },
        close: async () => { r.disconnect(); },
      };
    } catch (e) {
      log.warn({ err: String(e) }, 'redis unreachable — using the SQLite cache instead');
    }
  }
  return {
    kind: 'sqlite',
    get: async (k) => store.cacheGet(k),
    set: async (k, v, ttl) => store.cacheSet(k, v, ttl),
    close: async () => {},
  };
}
