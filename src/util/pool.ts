/** Runs fn over items with at most n in flight. */
export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { const item = items[i++]; await fn(item); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** Wraps fn so at most n calls run at once; the rest wait their turn. */
export function limited<A extends unknown[], R>(n: number, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async (...args) => {
    if (active >= n) await new Promise<void>((go) => queue.push(go));
    active++;
    try { return await fn(...args); } finally { active--; queue.shift()?.(); }
  };
}
