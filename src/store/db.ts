import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Status } from '../types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vacancies (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
  company TEXT, location TEXT, text TEXT NOT NULL, lang TEXT, posted_at TEXT,
  status TEXT NOT NULL, status_reason TEXT, score INTEGER,
  triage_json TEXT, plan_json TEXT, pack_dir TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS vacancies_status ON vacancies(status);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, vacancy_id TEXT, at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, run_id TEXT, stage TEXT, vacancy_id TEXT,
  model TEXT, prompt_version TEXT, prompt_hash TEXT, cache TEXT,
  input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
  cost_usd REAL, latency_ms INTEGER, attempt INTEGER, outcome TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS llm_calls_day ON llm_calls(day);
CREATE TABLE IF NOT EXISTS kv_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS feed_state (url TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, fetched_at TEXT);
CREATE TABLE IF NOT EXISTS ats_boards (company TEXT PRIMARY KEY, ats TEXT, board TEXT, checked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, vacancy_id TEXT, note TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applied_companies (url TEXT PRIMARY KEY, company TEXT, checked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS apply_links (vacancy_id TEXT PRIMARY KEY, link TEXT NOT NULL, via TEXT, at TEXT NOT NULL);
`;

export interface VacancyRow {
  id: string; source: string; url: string; title: string; company: string | null; location: string | null;
  text: string; lang: string | null; posted_at: string | null; status: Status; status_reason: string | null;
  score: number | null; triage_json: string | null; plan_json: string | null; pack_dir: string | null;
  attempts: number; discovered_at: string; updated_at: string;
}
export interface NewVacancy {
  id: string; source: string; url: string; title: string; company: string | null; location: string | null;
  text: string; lang: string | null; posted_at: string | null; status: Status; status_reason: string | null;
}
export interface LlmCallRecord {
  at: string; day: string; runId: string; stage: string; vacancyId: string; model: string;
  promptVersion: string; promptHash: string; cache: 'hit' | 'miss';
  inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number;
  costUsd: number | null; latencyMs: number; attempt: number; outcome: string; error: string | null;
}
export interface StageUsage {
  stage: string; calls: number; hits: number; input: number; cached: number; output: number;
  cost: number | null; latency: number | null; bad: number;
}

/** Legal status moves. Anything else is a bug, so it throws instead of silently corrupting the funnel. */
const TRANSITIONS: Record<Status, Status[]> = {
  new: ['filtered', 'triage_pending'],
  filtered: ['triage_pending', 'dismissed', 'applied'],
  triage_pending: ['triage_pending', 'filtered', 'rejected', 'borderline', 'shortlisted', 'tailor_pending', 'needs_review', 'failed', 'dismissed', 'applied'],
  shortlisted: ['tailor_pending', 'triage_pending', 'filtered', 'dismissed', 'applied'],
  rejected: ['triage_pending', 'tailor_pending', 'dismissed', 'applied'],
  borderline: ['triage_pending', 'tailor_pending', 'filtered', 'dismissed', 'applied'],
  tailor_pending: ['tailor_pending', 'filtered', 'ready', 'needs_review', 'failed', 'dismissed', 'applied'],
  needs_review: ['triage_pending', 'tailor_pending', 'ready', 'dismissed', 'applied'],
  ready: ['applied', 'dismissed', 'tailor_pending'],
  failed: ['triage_pending', 'tailor_pending', 'dismissed', 'applied'],
  applied: [],
  dismissed: ['triage_pending', 'external'],
  external: ['triage_pending', 'dismissed', 'applied'],
};

export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  /** Returns false when the vacancy was already known (dedupe by canonical key). */
  insertIfNew(v: NewVacancy): boolean {
    const now = new Date().toISOString();
    const r = this.db.prepare(`INSERT OR IGNORE INTO vacancies
      (id, source, url, title, company, location, text, lang, posted_at, status, status_reason, attempts, discovered_at, updated_at)
      VALUES (@id, @source, @url, @title, @company, @location, @text, @lang, @posted_at, @status, @status_reason, 0, @now, @now)`)
      .run({ ...v, now });
    if (r.changes === 1) this.event(v.id, 'discovered', { source: v.source, status: v.status, reason: v.status_reason });
    return r.changes === 1;
  }

  get(id: string): VacancyRow | undefined {
    return this.db.prepare('SELECT * FROM vacancies WHERE id = ?').get(id) as VacancyRow | undefined;
  }

  byStatus(statuses: Status[], limit = 1000): VacancyRow[] {
    const qs = statuses.map(() => '?').join(', ');
    return this.db.prepare(`SELECT * FROM vacancies WHERE status IN (${qs}) ORDER BY discovered_at LIMIT ?`).all(...statuses, limit) as VacancyRow[];
  }

  transition(id: string, to: Status, reason: string | null, patch: Partial<Pick<VacancyRow, 'score' | 'triage_json' | 'plan_json' | 'pack_dir' | 'attempts'>> = {}): void {
    const row = this.get(id);
    if (!row) throw new Error(`unknown vacancy ${id}`);
    if (!TRANSITIONS[row.status].includes(to)) throw new Error(`illegal transition ${row.status} → ${to} (${id})`);
    const fields: Record<string, unknown> = { ...patch, status: to, status_reason: reason, updated_at: new Date().toISOString() };
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE vacancies SET ${sets} WHERE id = @id`).run({ ...fields, id });
    this.event(id, 'status', { from: row.status, to, reason });
  }

  event(vacancyId: string | null, kind: string, data: unknown): void {
    this.db.prepare('INSERT INTO events (vacancy_id, at, kind, data) VALUES (?, ?, ?, ?)')
      .run(vacancyId, new Date().toISOString(), kind, JSON.stringify(data ?? null));
  }

  recordLlmCall(r: LlmCallRecord): void {
    this.db.prepare(`INSERT INTO llm_calls
      (at, day, run_id, stage, vacancy_id, model, prompt_version, prompt_hash, cache, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_usd, latency_ms, attempt, outcome, error)
      VALUES (@at, @day, @runId, @stage, @vacancyId, @model, @promptVersion, @promptHash, @cache, @inputTokens, @cachedTokens, @outputTokens, @reasoningTokens, @costUsd, @latencyMs, @attempt, @outcome, @error)`).run(r);
  }

  /** Today's real spend: cache hits cost nothing. */
  spend(day: string): { usd: number; tokens: number } {
    return this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
      FROM llm_calls WHERE day = ? AND cache = 'miss'`).get(day) as { usd: number; tokens: number };
  }

  usageForRun(runId: string): StageUsage[] {
    return this.db.prepare(`SELECT stage,
        COUNT(*) AS calls,
        SUM(CASE WHEN cache = 'hit' THEN 1 ELSE 0 END) AS hits,
        COALESCE(SUM(input_tokens), 0) AS input,
        COALESCE(SUM(cached_tokens), 0) AS cached,
        COALESCE(SUM(output_tokens), 0) AS output,
        SUM(cost_usd) AS cost,
        AVG(CASE WHEN cache = 'miss' THEN latency_ms END) AS latency,
        SUM(CASE WHEN outcome = 'ok' THEN 0 ELSE 1 END) AS bad
      FROM llm_calls WHERE run_id = ? GROUP BY stage ORDER BY stage`).all(runId) as StageUsage[];
  }

  feedState(url: string): { etag: string | null; last_modified: string | null } | undefined {
    return this.db.prepare('SELECT etag, last_modified FROM feed_state WHERE url = ?').get(url) as { etag: string | null; last_modified: string | null } | undefined;
  }
  saveFeedState(url: string, etag: string | null, lastModified: string | null): void {
    this.db.prepare(`INSERT INTO feed_state (url, etag, last_modified, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified, fetched_at = excluded.fetched_at`)
      .run(url, etag, lastModified, new Date().toISOString());
  }

  /** Which ATS board a company (normalised name) uses; `ats: null` = looked, found none. */
  boardGet(company: string): { ats: string | null; board: string | null; checked_at: string } | undefined {
    return this.db.prepare('SELECT ats, board, checked_at FROM ats_boards WHERE company = ?').get(company) as { ats: string | null; board: string | null; checked_at: string } | undefined;
  }
  boardSet(company: string, ref: { ats: string; board: string } | null, now = new Date()): void {
    this.db.prepare(`INSERT INTO ats_boards (company, ats, board, checked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(company) DO UPDATE SET ats = excluded.ats, board = excluded.board, checked_at = excluded.checked_at`)
      .run(company, ref?.ats ?? null, ref?.board ?? null, now.toISOString());
  }

  /** Another key the same job is known by (a LinkedIn id resolved to its ATS posting); `vacancy_id: null` = unresolved. */
  aliasGet(alias: string): { vacancy_id: string | null; note: string | null } | undefined {
    return this.db.prepare('SELECT vacancy_id, note FROM aliases WHERE alias = ?').get(alias) as { vacancy_id: string | null; note: string | null } | undefined;
  }
  aliasSet(alias: string, vacancyId: string | null, note: string | null): void {
    this.db.prepare(`INSERT INTO aliases (alias, vacancy_id, note, at) VALUES (?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET vacancy_id = excluded.vacancy_id, note = excluded.note, at = excluded.at`)
      .run(alias, vacancyId, note, new Date().toISOString());
  }

  /** Company behind a tracking-sheet link that doesn't name one; `null` = looked, unknown; `undefined` = not looked yet. */
  appliedCompanyGet(url: string): string | null | undefined {
    const r = this.db.prepare('SELECT company FROM applied_companies WHERE url = ?').get(url) as { company: string | null } | undefined;
    return r === undefined ? undefined : r.company;
  }
  appliedCompanySet(url: string, company: string | null): void {
    this.db.prepare('INSERT OR REPLACE INTO applied_companies (url, company, checked_at) VALUES (?, ?, ?)').run(url, company, new Date().toISOString());
  }

  /** Where a job board's "Apply" really leads (a company form or an email address), once found. */
  applyLinkGet(id: string): { link: string; via: string | null } | undefined {
    return this.db.prepare('SELECT link, via FROM apply_links WHERE vacancy_id = ?').get(id) as { link: string; via: string | null } | undefined;
  }
  applyLinkSet(id: string, link: string, via: string): void {
    this.db.prepare('INSERT OR REPLACE INTO apply_links (vacancy_id, link, via, at) VALUES (?, ?, ?, ?)').run(id, link, via, new Date().toISOString());
    this.event(id, 'apply_link', { link, via });
  }

  /** The company, learned after the vacancy came in (Djinni's feed doesn't name it; its job page does). */
  setCompany(id: string, company: string): void {
    this.db.prepare('UPDATE vacancies SET company = ?, updated_at = ? WHERE id = ?').run(company, new Date().toISOString(), id);
  }

  /** The posting text you pasted for a vacancy the agent can't read itself (LinkedIn and the like). */
  setText(id: string, text: string, lang: string | null): void {
    this.db.prepare('UPDATE vacancies SET text = ?, lang = ?, updated_at = ? WHERE id = ?').run(text, lang, new Date().toISOString(), id);
    this.event(id, 'text', { chars: text.length });
  }

  /** You sent this vacancy on by hand (`mark … triage|tailor`): automatic set-asides don't apply to it again. */
  markedByHand(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM events WHERE vacancy_id = ? AND kind = 'status' AND data LIKE '%marked by hand%' LIMIT 1").get(id));
  }

  cacheGet(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv_cache WHERE key = ? AND expires_at > ?').get(key, Date.now()) as { value: string } | undefined;
    return row?.value ?? null;
  }
  cacheSet(key: string, value: string, ttlSec: number): void {
    this.db.prepare(`INSERT INTO kv_cache (key, value, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`).run(key, value, Date.now() + ttlSec * 1000);
  }

  close(): void { this.db.close(); }
}
