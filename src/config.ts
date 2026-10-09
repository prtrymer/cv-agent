import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ROLE_FAMILIES } from './types.js';

const Stage = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  maxTokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2),
  extraBody: z.record(z.string(), z.unknown()).default({}),
});

export const ConfigSchema = z.object({
  mode: z.enum(['dry-run', 'live']).default('dry-run'),
  timezone: z.string().default('Europe/Prague'),
  workingHours: z.object({
    days: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
    start: z.string().regex(/^\d\d:\d\d$/).default('09:00'),
    end: z.string().regex(/^\d\d:\d\d$/).default('17:30'),
    czechHolidays: z.boolean().default(true),
    extraDaysOff: z.array(z.string()).default([]),
  }).prefault({}),
  paths: z.object({
    profile: z.string().default('data/profile.yaml'),
    answers: z.string().default('data/answers.yaml'),
    coverLetterBase: z.string().default('data/base/cover_letter.md'),
    appliedSeed: z.string().default('data/applied.txt'),
    prompts: z.string().default('prompts'),
    css: z.string().default('templates/cv.css'),
    out: z.string().default('out'),
    logs: z.string().default('logs'),
    db: z.string().default('data/state.db'),
    /** Companies whose own job boards are polled every run; null turns the watchlist off. */
    watchlist: z.string().nullable().default('data/companies.yaml'),
  }).prefault({}),
  llm: z.object({
    provider: z.enum(['openai-compatible', 'mock']).default('openai-compatible'),
    baseUrl: z.string().default('https://openrouter.ai/api/v1'),
    apiKeyEnv: z.string().default('LLM_API_KEY'),
    mockDir: z.string().default('fixtures/llm'),
    timeoutMs: z.number().int().positive().default(90_000),
    maxRetries: z.number().int().min(0).max(8).default(4),
    maxRepairRounds: z.number().int().min(0).max(3).default(1),
    toolChoice: z.enum(['forced', 'required', 'auto']).default('forced'),
    circuitBreakerFailures: z.number().int().positive().default(5),
    pricing: z.object({
      inputPerM: z.number().nonnegative().nullable().default(null),
      cachedInputPerM: z.number().nonnegative().nullable().default(null),
      outputPerM: z.number().nonnegative().nullable().default(null),
    }).prefault({}),
    /** triage: screen a posting · tailor: CV + letter plan · extract: jobs out of an alert email · answer: application-form questions */
    stages: z.object({ triage: Stage, tailor: Stage, extract: Stage, answer: Stage }),
    budget: z.object({
      dailyUsd: z.number().positive().default(1),
      dailyTokens: z.number().int().positive().default(500_000),
    }).prefault({}),
  }),
  cache: z.object({
    redisUrlEnv: z.string().default('REDIS_URL'),
    ttlDays: z.object({
      triage: z.number().positive().default(30),
      tailor: z.number().positive().default(14),
      extract: z.number().positive().default(30),
      answer: z.number().positive().default(30),
    }).prefault({}),
  }).prefault({}),
  pipeline: z.object({
    maxTriagePerRun: z.number().int().positive().default(40),
    maxTailorPerRun: z.number().int().positive().default(8),
    concurrency: z.number().int().min(1).max(8).default(2),
    applyThreshold: z.number().int().min(0).max(100).default(70),
    borderlineMin: z.number().int().min(0).max(100).default(55),
    vacancyCharLimit: z.number().int().positive().default(6000),
    maxAttempts: z.number().int().positive().default(3),
    maxGapMonths: z.number().int().min(0).default(2),
    /** Postings older than this are skipped before screening (free); undated ones are always screened. */
    maxAgeDays: z.number().int().positive().default(10),
    /** Role families in scope; triage puts every posting in one, anything else is rejected before tailoring. */
    roleFamilies: z.array(z.enum(ROLE_FAMILIES)).min(1).default(['fullstack']),
    /** Postings asking up to this many years (total or per technology) are fine to apply to. */
    yearsOk: z.number().positive().default(5),
    /** Lowest seniority worth applying to; screening's verdict below it is a reject. */
    minSeniority: z.enum(['junior', 'middle', 'senior']).default('middle'),
    /** Hold what screening approves as "shortlisted" until you say which get a CV (`review`, or the dashboard). */
    approveBeforeTailor: z.boolean().default(false),
  }).prefault({}),
  prefilter: z.object({
    titleInclude: z.array(z.string()).default([]),
    titleExclude: z.array(z.string()).default([]),
    maxYearsRequired: z.number().positive().default(6),
    /** Drop trainee / intern / junior-only titles before screening ("Junior+/Middle" still passes). */
    skipJuniorTitles: z.boolean().default(true),
    /** Djinni's own hard filters, read off the job page: it hides the reply form from profiles that don't meet them. */
    djinni: z.object({
      enabled: z.boolean().default(true),
      /** Years of experience in your Djinni profile (Djinni compares its own number, not the CV). */
      experienceYears: z.number().min(0).default(3),
      /** Patterns (case-insensitive) one of which "Countries where we consider candidates" must match. */
      countries: z.array(z.string()).default(['europe', '\\beu\\b', 'czech', 'world', 'anywhere']),
    }).prefault({}),
  }).prefault({}),
  sources: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    kind: z.enum(['dou', 'djinni', 'rss']),
    url: z.string().min(1),
    enabled: z.boolean().default(true),
  })).default([]),
  alerts: z.object({
    /** LinkedIn / Glassdoor job-alert emails, read over IMAP (read-only) and resolved to the company's own posting. */
    enabled: z.boolean().default(false),
    host: z.string().default('imap.gmail.com'),
    port: z.number().int().positive().default(993),
    userEnv: z.string().default('IMAP_USER'),
    passwordEnv: z.string().default('IMAP_PASSWORD'),
    mailbox: z.string().default('INBOX'),
    lookbackDays: z.number().int().positive().default(7),
    senders: z.array(z.string()).default(['jobs-noreply@linkedin.com', 'noreply@glassdoor.com', 'donotreply@match.indeed.com', 'pomuzeme@jobs.cz', 'magic@djinni.co']),
  }).prefault({}),
  apply: z.object({
    /** assisted: fills the form in a visible browser, you press Submit · simulate: fills headless, screenshots, never submits */
    mode: z.enum(['assisted', 'simulate']).default('assisted'),
    browserProfile: z.string().default('data/browser-profile'),
    waitMinutes: z.number().positive().default(30),
    maxFreeTextChars: z.number().int().positive().default(1500),
    /**
     * Job boards whose pages sit behind a bot check (Cloudflare) and show the company's apply link only to a signed-in
     * account. The agent's window is never pointed at them: it looks the job up on the company's own board, or you
     * open the posting in your own browser and paste where "Apply" leads.
     */
    protectedBoards: z.array(z.string()).default(['weworkremotely.com']),
  }).prefault({}),
  ats: z.object({
    /** How long "this company has no public board" is trusted before looking again. */
    probeTtlDays: z.number().positive().default(30),
  }).prefault({}),
  http: z.object({
    userAgent: z.string().default('cv-agent/0.1 (personal job-search assistant)'),
    timeoutMs: z.number().int().positive().default(20_000),
    minIntervalMsPerHost: z.number().int().min(0).default(3000),
    maxBytes: z.number().int().positive().default(3_000_000),
  }).prefault({}),
  render: z.object({
    engine: z.enum(['playwright', 'wkhtmltopdf', 'chromium', 'none']).default('playwright'),
    binary: z.string().nullable().default(null),
    maxPages: z.number().int().positive().default(2),
  }).prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out;
}

/** Reads a config file, resolving `extends:` chains relative to the file. */
export function readConfigRaw(file: string): Record<string, unknown> {
  const raw = (YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  const { extends: ext, ...rest } = raw;
  if (typeof ext === 'string') return deepMerge(readConfigRaw(path.resolve(path.dirname(file), ext)), rest) as Record<string, unknown>;
  return rest;
}

export function parseConfig(raw: unknown, label = 'config'): Config {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${label}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export const loadConfig = (file: string): Config => parseConfig(readConfigRaw(file), file);
