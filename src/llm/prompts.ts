import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../util/hash.js';

export interface Prompt { text: string; version: string; hash: string }

/** Prompts are files under version control; the hash goes into every log line and into the cache key. */
export function loadPrompt(dir: string, ref: string, vars: Record<string, string>): Prompt {
  const raw = fs.readFileSync(path.join(dir, `${ref}.md`), 'utf8');
  const text = raw.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`prompt ${ref}: no value for {{${k}}}`);
    return v;
  });
  return { text, version: ref, hash: sha256(text).slice(0, 16) };
}
