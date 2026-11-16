import type { Config } from './config.js';
import type { Logger } from './log.js';
import type { Store } from './store/db.js';
import type { Cache } from './cache/cache.js';
import type { LlmClient } from './llm/client.js';
import type { Prompt } from './llm/prompts.js';
import type { Knowledge } from './profile/profile.js';
import type { LetterBase } from './render/letter.js';

export interface Ctx {
  cfg: Config;
  log: Logger;
  store: Store;
  cache: Cache;
  llm: LlmClient;
  k: Knowledge;
  prompts: { triage: Prompt; tailor: Prompt; extract: Prompt; answer: Prompt };
  letterBase: LetterBase;
  css: string;
  runId: string;
  now: () => Date;
  close(): Promise<void>;
  /**
   * Re-reads config, .env, profile, answers, prompts, letter and CSS, with a new LLM client and run id; keeps the open
   * database, cache and log. The dashboard calls it before each job so edits apply without a restart. Throws when the
   * config is invalid or moves the database, logs or cache, which only a restart can switch.
   */
  reload?(): Ctx;
}
