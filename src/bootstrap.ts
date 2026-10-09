import fs from 'node:fs';
import path from 'node:path';
import { createCache } from './cache/cache.js';
import { deepMerge, parseConfig, readConfigRaw, type Config } from './config.js';
import type { Ctx } from './ctx.js';
import { HttpTransport, LlmClient, type Transport } from './llm/client.js';
import { MockTransport } from './llm/mock.js';
import { loadPrompt } from './llm/prompts.js';
import { createLogger } from './log.js';
import { buildKnowledge, loadAnswers, loadProfile } from './profile/profile.js';
import { answersText, familiesText, tailorFactbaseText, triageProfileText } from './profile/serialize.js';
import { parseBaseLetter } from './render/letter.js';
import { maskDurations } from './pipeline/validate.js';
import { Store } from './store/db.js';

export interface BootstrapOptions {
  overrides?: Record<string, unknown>;
  quiet?: boolean;
  /** Start from an empty state database — used by `run --fresh` and the demo. A real database is backed up, never deleted. */
  fresh?: boolean;
  /** Don't throw when the API key is missing (`doctor` reports it instead). The LLM is unusable in that context. */
  allowMissingKey?: boolean;
  now?: () => Date;
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
}

export async function bootstrap(configPath: string, o: BootstrapOptions = {}): Promise<Ctx> {
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
  const cfg: Config = parseConfig(deepMerge(readConfigRaw(configPath), o.overrides ?? {}), configPath);

  const log = createLogger(o.quiet ? null : cfg.paths.logs);
  if (o.fresh) {
    const backup = startFresh(cfg.paths.db, cfg.llm.provider === 'mock', (o.now ?? (() => new Date()))());
    if (backup) log.warn({ backup }, 'fresh start — previous state database moved aside');
  }
  const store = new Store(cfg.paths.db);
  const now = o.now ?? (() => new Date());

  const profile = loadProfile(cfg.paths.profile);
  const answers = loadAnswers(cfg.paths.answers);
  const k = buildKnowledge(profile.data, answers, profile.raw, { now: now(), maxGapMonths: cfg.pipeline.maxGapMonths });
  const missing = cfg.pipeline.roleFamilies.filter((f) => !k.families.has(f));
  if (missing.length) throw new Error(`pipeline.roleFamilies: ${missing.join(', ')} has no positioning.families entry in ${cfg.paths.profile}`);
  const letterBase = parseBaseLetter(fs.readFileSync(cfg.paths.coverLetterBase, 'utf8'));

  const prompts = {
    triage: loadPrompt(cfg.paths.prompts, cfg.llm.stages.triage.prompt, { profile: triageProfileText(k), years_ok: String(cfg.pipeline.yearsOk) }),
    tailor: loadPrompt(cfg.paths.prompts, cfg.llm.stages.tailor.prompt, {
      positioning: k.profile.positioning.default,
      total_years: String(k.totalYears),
      factbase: tailorFactbaseText(k),
      voice: maskDurations(letterBase.voice),
      families: familiesText(k),
    }),
    extract: loadPrompt(cfg.paths.prompts, cfg.llm.stages.extract.prompt, {}),
    answer: loadPrompt(cfg.paths.prompts, cfg.llm.stages.answer.prompt, { factbase: tailorFactbaseText(k), answers: answersText(k) }),
  };

  const cache = await createCache(process.env[cfg.cache.redisUrlEnv], store, log);
  const transport = o.transport ?? (cfg.llm.provider === 'mock'
    ? new MockTransport(path.resolve(cfg.llm.mockDir))
    : new HttpTransport(cfg.llm.baseUrl, o.allowMissingKey ? (process.env[cfg.llm.apiKeyEnv] ?? '') : requireEnv(cfg.llm.apiKeyEnv)));

  const runId = now().toISOString().replace(/[:.]/g, '-');
  const llm = new LlmClient({ cfg, transport, cache, store, log, runId, logDir: path.join(cfg.paths.logs, 'llm'), sleep: o.sleep });

  return {
    cfg, log, store, cache, llm, k, prompts, letterBase,
    css: fs.readFileSync(cfg.paths.css, 'utf8'),
    runId, now,
    close: async () => { await cache.close(); store.close(); },
  };
}

/**
 * Empties the state database. Demo/mock databases are disposable; a real one holds every vacancy you've seen,
 * dismissed or applied to, so it is moved to `<db>.bak-<timestamp>` instead. Returns the backup path, if any.
 */
export function startFresh(db: string, disposable: boolean, now: Date): string | null {
  const suffixes = ['', '-wal', '-shm'];
  if (disposable || !fs.existsSync(db)) {
    for (const s of suffixes) fs.rmSync(`${db}${s}`, { force: true });
    return null;
  }
  const backup = `${db}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
  for (const s of suffixes) if (fs.existsSync(`${db}${s}`)) fs.renameSync(`${db}${s}`, `${backup}${s}`);
  return backup;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — put it in .env (see .env.example), or use \`npm run demo\` for the offline demo`);
  return v;
}
