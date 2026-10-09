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
}
