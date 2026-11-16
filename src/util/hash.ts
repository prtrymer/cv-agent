import { createHash } from 'node:crypto';

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]));
  }
  return v;
}
/** Key-order-independent JSON, so cache keys don't change when object literals get reordered. */
export const stableStringify = (v: unknown): string => JSON.stringify(sortKeys(v));
