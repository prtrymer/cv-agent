import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../ctx.js';
import { LlmError } from '../llm/client.js';
import { detectTech, labelOf } from '../profile/lexicon.js';
import { excludedFor, forVacancy, frameworksFor, type Knowledge } from '../profile/profile.js';
import { htmlToPdf, renderCvHtml } from '../render/cv.js';
import { composeLetter, letterText, writeLetterDocx } from '../render/letter.js';
import { parseRss } from '../sources/rss.js';
import { loadWatchlist, readCompany } from '../sources/watchlist.js';
import { alertLink, extractJobs, isCardOnly, type AlertLink } from '../sources/alerts.js';
import { ImapMailSource, type AlertMail, type MailSource } from '../sources/mail.js';
import type { VacancyRow } from '../store/db.js';
import type { RawVacancy, RoleFamily, Status } from '../types.js';
import { politeFetch } from '../util/http.js';
import { djinniCheck, parseDjinniRequirements, type DjinniRequirements } from '../sources/djinni.js';
import { limited, pool } from '../util/pool.js';
import { cleanLine, detectInjection, detectLang, htmlToText, sanitizeUntrusted, slug } from '../util/text.js';
import { canonicalize } from '../util/url.js';
import { prefilter, seniorityCheck } from './prefilter.js';
import { coercePlan, makePlanSchema, pitchRules } from './tailor.js';
import { appliedCompanies, appliedDates, earlierApplication, repostNote, type AppliedEntry, type EarlierCheck } from './applied.js';
import { foldTwins } from './twins.js';
import { coerceTriage, decide, TriageSchema, vacancyBlock, type Triage } from './triage.js';
import { validatePlan, type Plan } from './validate.js';

export interface PackInfo {
  id: string; title: string; company: string | null; url: string; score: number | null;
  dir: string; status: Status; issues: string[]; why: string[];
}
export interface Listed { id: string; title: string; company: string | null; url: string; score: number | null; reason: string }
export interface RunSummary {
  runId: string; mode: string; startedAt: string; finishedAt: string;
  discovered: number; fresh: number;
  filtered: Record<string, number>;
  triaged: { apply: number; reject: number; review: number };
  packs: PackInfo[];
  rejected: Listed[];
  /** Screening said apply; waiting for your go (pipeline.approveBeforeTailor). */
  shortlisted: Listed[];
  failed: number;
  stopped: string | null;
  sourceErrors: Array<{ source: string; error: string }>;
  pending: { triage: number; approve: number; tailor: number };
  failures: string[];
  /** Set aside before any model call: you already applied to this company (with the earlier link). */
  sameCompany: Array<Listed & { earlier: string }>;
  /** Posted again long after you applied (pipeline.repostAfterDays): screened again instead of set aside. */
  reposted: Array<Listed & { earlier: string; appliedAt: string }>;
  /** Jobs from this run's alert emails: listed as links (with their email), never screened. */
  alertJobs: AlertLink[];
  /** Earlier verdicts re-decided under the current rules (pipeline.applyThreshold, yearsOk), no model call. */
  redecided: number;
}

/** "Alex Doe" → Alex_Doe_CV.pdf, Alex_Doe_Cover_Letter.docx. */
export function packFileNames(personName: string): { cvHtml: string; cvPdf: string; letterDocx: string } {
  const stem = personName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'CV';
  return { cvHtml: `${stem}_CV.html`, cvPdf: `${stem}_CV.pdf`, letterDocx: `${stem}_Cover_Letter.docx` };
}

/** Does a stored vacancy come from one of these source ids? `watchlist` covers company boards, `alerts` alert emails. */
export function fromSources(ids: string[], rowSource: string): boolean {
  return ids.includes(rowSource) || (ids.includes('watchlist') && rowSource.startsWith('ats-')) || (ids.includes('alerts') && rowSource.startsWith('alert-'));
}

/** "web scraping", "scrapers", "crawl and extract data", "Crawlee" — a posting about getting data off websites. */
const SCRAPING = /\b(scrap(?:e|er|ers|ing)|crawl(?:s|er|ers|ing|ee)?)\b/i;

/** What the posting asks for lifts the family's never-mention list: a "Node.js + Java" backend role may say Java. */
export function postingWants(title: string, text: string): Set<string> {
  const wanted = detectTech(`${title}\n${text}`);
  // A scraping role wants a scraper bullet even on a TypeScript CV, and that bullet is about JSoup.
  if (SCRAPING.test(text)) wanted.add('jsoup');
  // Every Java fact in the profile says "Java/Spring": a posting that allows Java allows Spring with it (2026-11-02).
  if (wanted.has('java')) wanted.add('spring');
  return wanted;
}

/**
 * Which family's CV a vacancy gets. One out of scope ("other": a generic Software Engineer role, or one pushed here by
 * `mark … tailor`) gets the Java CV when the posting names Java and no TypeScript/JavaScript (2026-11-07),
 * the fullstack CV otherwise.
 */
export function cvFamily(roleFamily: string | undefined, wanted: Set<string>, families: { has(f: string): boolean }): RoleFamily {
  if (roleFamily && roleFamily !== 'other' && families.has(roleFamily)) return roleFamily as RoleFamily;
  const js = ['typescript', 'javascript', 'nodejs'].some((t) => wanted.has(t));
  return wanted.has('java') && !js && families.has('java') ? 'java' : 'fullstack';
}

const listed = (row: VacancyRow, reason: string): Listed => ({ id: row.id, title: row.title, company: row.company, url: row.url, score: row.score, reason });

/**
 * One line of the tracking file: a link, optionally followed by `# Company` for links that don't name one, and the
 * date you applied (`# Company 2026-09-22`, or `# 2026-09-22`) when it wasn't the day the line was added.
 */
export function parseAppliedLine(line: string): AppliedEntry | null {
  const [url, note = ''] = line.trim().split(/\s+#\s*/, 2);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const on = /(?:^|\s)(\d{4}-\d{2}-\d{2})\s*$/.exec(note)?.[1] ?? null;
  return { url, company: (on ? note.slice(0, note.length - on.length) : note).trim() || null, on };
}

/** The tracking-file line for an application made today: the link, the company when known, and the date. */
export const appliedLine = (url: string, company: string | null, now: Date): string => `${url}   # ${company ? `${company} ` : ''}${now.toISOString().slice(0, 10)}\n`;

export const appliedEntries = (ctx: Ctx): AppliedEntry[] => (fs.existsSync(ctx.cfg.paths.appliedSeed)
  ? fs.readFileSync(ctx.cfg.paths.appliedSeed, 'utf8').split('\n').map(parseAppliedLine).filter((e): e is AppliedEntry => e !== null)
  : []);

export function loadAppliedKeys(ctx: Ctx): Set<string> {
  return new Set(appliedEntries(ctx).map((e) => canonicalize(e.url)?.key).filter((k): k is string => Boolean(k)));
}

async function readSource(ctx: Ctx, src: { id: string; kind: 'dou' | 'djinni' | 'rss'; url: string }): Promise<RawVacancy[]> {
  if (/^https?:\/\//i.test(src.url)) {
    const state = ctx.store.feedState(src.url);
    const res = await politeFetch(src.url, ctx.cfg.http, { etag: state?.etag, lastModified: state?.last_modified });
    if (res.notModified) { ctx.log.info({ source: src.id }, 'feed unchanged since last run'); return []; }
    ctx.store.saveFeedState(src.url, res.etag, res.lastModified);
    return parseRss(res.text, src.id, src.kind);
  }
  return parseRss(fs.readFileSync(path.resolve(src.url), 'utf8'), src.id, src.kind);
}

/**
 * A posting you applied to through this very link, posted again (a newer date in the feed) at least
 * pipeline.repostAfterDays after you applied: the note it is screened again with, else null.
 */
function repostedLink(ctx: Ctx, appliedAt: string | undefined, postedAt: string | null | undefined, before: string | null): string | null {
  const days = ctx.cfg.pipeline.repostAfterDays;
  const posted = postedAt ? Date.parse(postedAt) : NaN;
  if (!appliedAt || days === null || !Number.isFinite(posted)) return null;
  if (before && Number.isFinite(Date.parse(before)) && posted <= Date.parse(before)) return null; // same posting date: not posted again
  return posted - Date.parse(appliedAt) >= days * 86_400_000 ? repostNote(appliedAt, ctx.now()) : null;
}

/** `appliedAt` (tracking-sheet links and vacancies marked applied → when) lets a long-ago application's repost through. */
export function ingest(ctx: Ctx, raw: RawVacancy, applied: Set<string>, summary: RunSummary, appliedAt?: Map<string, string>): void {
  const canon = canonicalize(raw.url);
  if (!canon) { ctx.log.warn({ url: raw.url }, 'unusable vacancy link, skipped'); return; }
  const body = raw.descriptionText ?? (raw.descriptionHtml ? htmlToText(raw.descriptionHtml) : '');
  const text = sanitizeUntrusted(body, ctx.cfg.pipeline.vacancyCharLimit);
  const title = cleanLine(raw.title) ?? 'Untitled role';
  const known = appliedAt?.has(canon.key) ? ctx.store.get(canon.key) : undefined;
  const reposted = appliedAt?.has(canon.key) ? repostedLink(ctx, appliedAt.get(canon.key), raw.postedAt, known?.posted_at ?? null) : null;
  if (known && reposted) {
    // Seen before and set aside (or applied to): it comes back as new, with the new date, and goes through every filter again.
    if (known.status !== 'applied' && !(known.status === 'filtered' && /^already applied/.test(known.status_reason ?? ''))) return;
    if (known.status === 'applied' && !applied.has(canon.key)) fs.appendFileSync(ctx.cfg.paths.appliedSeed, appliedLine(known.url, known.company, new Date(appliedAt!.get(canon.key)!)));
    ctx.store.setPostedAt(known.id, raw.postedAt!);
    ctx.store.transition(known.id, 'new', reposted);
    summary.fresh++;
    summary.reposted.push({ ...listed(known, reposted), earlier: known.url, appliedAt: appliedAt!.get(canon.key)! });
    return;
  }
  const alreadyApplied = applied.has(canon.key) && !reposted;
  const inserted = ctx.store.insertIfNew({
    id: canon.key,
    source: raw.source,
    url: canon.url,
    title,
    company: cleanLine(raw.company),
    location: cleanLine(raw.location),
    text,
    lang: detectLang(`${title}\n${text}`),
    posted_at: raw.postedAt ?? null,
    status: alreadyApplied ? 'filtered' : 'new',
    status_reason: alreadyApplied ? 'already applied (tracking sheet)' : reposted,
  });
  if (!inserted) return;
  summary.fresh++;
  if (reposted) summary.reposted.push({ id: canon.key, title, company: cleanLine(raw.company), url: canon.url, score: null, reason: reposted, earlier: canon.url, appliedAt: appliedAt!.get(canon.key)! });
  if (alreadyApplied) summary.filtered['already applied'] = (summary.filtered['already applied'] ?? 0) + 1;
}

export interface RunOptions {
  sources?: string[];
  manual?: RawVacancy[];
  mail?: MailSource;
  /** 'tailor': only build packs for vacancies already approved — no discovery, no screening. */
  stage?: 'tailor';
  /** Set by Ctrl+C: finish the calls in flight, start nothing new, still write the report. */
  stop?: { requested: boolean };
  /** Screen and write only these vacancies (the dashboard's "paste posting text"). */
  only?: string[];
  /** With `only`: screen them, but what passes waits on your shortlist like any other (re-screening, not your pick). */
  shortlistOnly?: boolean;
  /** One human-readable line per step (the CLI prints them; logs keep the detail). */
  say?: (line: string) => void;
}

export async function runPipeline(ctx: Ctx, opts: RunOptions = {}): Promise<RunSummary> {
  const summary: RunSummary = {
    runId: ctx.runId, mode: ctx.cfg.mode, startedAt: ctx.now().toISOString(), finishedAt: '',
    discovered: 0, fresh: 0, filtered: {}, triaged: { apply: 0, reject: 0, review: 0 },
    packs: [], rejected: [], shortlisted: [], failed: 0, stopped: null, sourceErrors: [], pending: { triage: 0, approve: 0, tailor: 0 }, alertJobs: [], redecided: 0, failures: [], sameCompany: [], reposted: [],
  };
  const applied = loadAppliedKeys(ctx);
  const appliedAt = appliedDates(ctx, appliedEntries(ctx));
  const say = opts.say ?? (() => {});
  const halted = () => Boolean(summary.stopped || opts.stop?.requested);
  const who = (r: { title: string; company: string | null }) => `${r.title}${r.company ? ` · ${r.company}` : ''}`.slice(0, 90);

  // `add` works on the vacancies it was given, never on the backlog other runs left queued.
  const manualIds: string[] = [];
  for (const raw of opts.manual ?? []) {
    summary.discovered++;
    const canon = canonicalize(raw.url);
    const known = canon ? ctx.store.get(canon.key) : undefined;
    ingest(ctx, raw, applied, summary);
    const row = canon ? ctx.store.get(canon.key) : undefined;
    if (!row) { say(`Can't use this link: ${raw.url}`); continue; }
    manualIds.push(row.id);
    if (row.status === 'new') ctx.store.transition(row.id, 'triage_pending', 'added by hand');
    else if (known) {
      // Already in the list (a feed found it earlier, a filter dropped it…): adding it by hand is your pick, so it is screened again.
      // Pasted text always replaces what is stored. Text read from the link replaces it only when it is longer: a link
      // that read as empty the first time (Workable's shell page, 2026-11-13) is fixed by adding it again,
      // and a full posting from a feed is never swapped for a thinner page.
      const read = raw.descriptionText ? '' : sanitizeUntrusted(raw.descriptionHtml ? htmlToText(raw.descriptionHtml) : '', ctx.cfg.pipeline.vacancyCharLimit);
      const text = raw.descriptionText ? sanitizeUntrusted(raw.descriptionText, ctx.cfg.pipeline.vacancyCharLimit) : read.length > row.text.length ? read : '';
      if (text) ctx.store.setText(row.id, text, detectLang(`${row.title}\n${text}`));
      ctx.store.fillMissing(row.id, cleanLine(raw.company), cleanLine(raw.location));
      try {
        ctx.store.transition(row.id, 'triage_pending', `marked by hand: added again (was ${known.status})`, { attempts: 0 });
        say(`Already in your list as "${known.status}"${known.status_reason ? ` (${known.status_reason})` : ''} — screening it again: ${who(row)}`);
      } catch {
        say(`Already in your list as "${known.status}" — left as it is: ${who(row)}`);
      }
    }
  }
  // `--source` limits the whole run — screening and tailoring too, not just discovery — to vacancies from those sources.
  const inScope = (row: VacancyRow): boolean => !opts.sources || fromSources(opts.sources, row.source);
  const onlyIds = opts.only ?? (opts.manual ? manualIds : null);
  const queued = (status: Status, limit: number): VacancyRow[] => (onlyIds
    ? onlyIds.map((id) => ctx.store.get(id)).filter((r): r is VacancyRow => r?.status === status)
    : ctx.store.byStatus([status], 100_000).filter(inScope).slice(0, limit));

  if (!opts.manual && !opts.only && opts.stage !== 'tailor') {
    for (const src of ctx.cfg.sources.filter((s) => s.enabled && (!opts.sources || opts.sources.includes(s.id)))) {
      if (halted()) break;
      try {
        const raws = await readSource(ctx, src);
        summary.discovered += raws.length;
        const before = summary.fresh;
        for (const raw of raws) ingest(ctx, raw, applied, summary, appliedAt);
        say(`Reading ${src.id}: ${raws.length} postings, ${summary.fresh - before} new`);
      } catch (e) {
        summary.sourceErrors.push({ source: src.id, error: (e as Error).message });
        say(`Reading ${src.id}: failed — ${(e as Error).message.slice(0, 100)}`);
        ctx.log.error({ source: src.id, err: (e as Error).message }, 'source failed');
      }
    }
    if (!opts.sources || opts.sources.includes('watchlist')) {
      for (const entry of loadWatchlist(ctx.cfg.paths.watchlist)) {
        if (halted()) break;
        try {
          const board = await readCompany(ctx, entry);
          summary.discovered += board.jobs.length;
          say(`Reading ${entry.name} (${board.ref.ats}): ${board.total} open jobs, ${board.jobs.length} with a matching title`);
          const skipped = board.total - board.jobs.length;
          if (skipped > 0) summary.filtered['board titles'] = (summary.filtered['board titles'] ?? 0) + skipped;
          for (const raw of board.jobs) ingest(ctx, raw, applied, summary, appliedAt);
        } catch (e) {
          summary.sourceErrors.push({ source: `watchlist: ${entry.name}`, error: (e as Error).message });
          ctx.log.error({ company: entry.name, err: (e as Error).message }, 'watchlist company failed');
        }
      }
    }
    if (!ctx.cfg.alerts.enabled && opts.sources?.includes('alerts')) {
      summary.sourceErrors.push({ source: 'alerts', error: 'alert emails are off — set alerts.enabled: true in config/agent.yaml (after IMAP_USER / IMAP_PASSWORD in .env)' });
    }
    if (ctx.cfg.alerts.enabled && (!opts.sources || opts.sources.includes('alerts')) && !halted()) {
      try {
        await readAlerts(ctx, opts.mail ?? new ImapMailSource(ctx.cfg.alerts), applied, summary, say);
      } catch (e) {
        summary.sourceErrors.push({ source: 'alerts', error: (e as Error).message });
        ctx.log.error({ err: (e as Error).message }, 'alert emails failed');
      }
    }
  }

  if (opts.stage !== 'tailor' && !onlyIds) {
    summary.redecided = redecide(ctx);
    if (summary.redecided) say(`Earlier verdicts under the current rules: ${summary.redecided} moved to your shortlist`);
  }

  const newRows = opts.stage === 'tailor' ? [] : ctx.store.byStatus(['new']);
  for (const row of newRows) {
    const result = prefilter(row, ctx.cfg.prefilter, ctx.k.location, ctx.cfg.pipeline.minSeniority);
    if (result.pass) ctx.store.transition(row.id, 'triage_pending', row.status_reason?.startsWith('reposted:') ? row.status_reason : null);
    else {
      ctx.store.transition(row.id, 'filtered', result.reason);
      const bucket = result.reason.split(':')[0];
      summary.filtered[bucket] = (summary.filtered[bucket] ?? 0) + 1;
    }
  }

  // Never spend a model call (or send a CV) on a company you already applied to, unless you sent it on by hand — or
  // it is the same role posted again long after you applied (pipeline.repostAfterDays): then it is screened again.
  const earlierApps = await appliedCompanies(ctx, appliedEntries(ctx));
  const recheck = (row: VacancyRow): EarlierCheck => earlierApplication(earlierApps, row, {
    separate: ctx.cfg.pipeline.separateEmployers, days: ctx.cfg.pipeline.repostAfterDays, now: ctx.now(), own: appliedAt.get(row.id) ?? null,
  });
  const screenAgain = (row: VacancyRow, repost: { link: string; at: string }): void => {
    if (row.status === 'triage_pending' && row.status_reason?.startsWith('reposted:')) return; // already noted when it came in
    const note = repostNote(repost.at, ctx.now(), repost.link === row.url ? undefined : repost.link);
    ctx.store.transition(row.id, 'triage_pending', note);
    summary.reposted.push({ ...listed(row, note), earlier: repost.link, appliedAt: repost.at });
  };
  // Set aside earlier for an application that is long enough ago now (recent postings only: older ones are stale anyway).
  const recent = ctx.now().getTime() - ctx.cfg.pipeline.maxAgeDays * 86_400_000;
  if (opts.stage !== 'tailor' && !onlyIds && ctx.cfg.pipeline.repostAfterDays !== null) {
    for (const row of ctx.store.byStatus(['filtered'], 100_000).filter(inScope)) {
      if (!/^already applied to /.test(row.status_reason ?? '') || Date.parse(row.posted_at ?? row.discovered_at) < recent) continue;
      const { repost } = recheck(row);
      if (repost) screenAgain(row, repost);
    }
  }
  // Stale postings are skipped for free: feeds reach back a month, and an old vacancy is usually filled.
  // Vacancies you add by hand are never skipped.
  const cutoff = ctx.now().getTime() - ctx.cfg.pipeline.maxAgeDays * 86_400_000;
  for (const row of opts.stage === 'tailor' ? [] : ctx.store.byStatus(['triage_pending']).filter(inScope)) {
    const posted = row.posted_at ? Date.parse(row.posted_at) : NaN;
    if (manualIds.includes(row.id) || opts.only?.includes(row.id) || !Number.isFinite(posted) || posted >= cutoff) continue;
    ctx.store.transition(row.id, 'filtered', `posted ${Math.floor((ctx.now().getTime() - posted) / 86_400_000)} days ago`);
    summary.filtered['too old'] = (summary.filtered['too old'] ?? 0) + 1;
  }

  // Djinni won't show you a reply form when its own requirements (years, countries) rule your profile out: read them
  // off the public job page and drop those for free. Shortlisted and borderline ones too — no point deciding on them.
  if (ctx.cfg.prefilter.djinni.enabled && opts.stage !== 'tailor') {
    const onDjinni = ctx.store.byStatus(['triage_pending', 'shortlisted', 'borderline']).filter(inScope)
      .filter((row) => /^https:\/\/djinni\.co\/jobs\//.test(row.url) && !manualIds.includes(row.id) && !opts.only?.includes(row.id) && !ctx.store.markedByHand(row.id));
    let dropped = 0;
    for (const row of onDjinni) {
      if (halted()) break;
      const key = `djinni-reqs:${row.id}`;
      let reqs: DjinniRequirements | null = null;
      try { reqs = JSON.parse(ctx.store.cacheGet(key) ?? 'null'); } catch { /* refetch */ }
      if (!reqs || !('company' in reqs)) { // cached before the company was read off the page: read it again
        try {
          reqs = parseDjinniRequirements((await politeFetch(row.url, ctx.cfg.http)).text);
          ctx.store.cacheSet(key, JSON.stringify(reqs), 7 * 86_400);
        } catch { continue; } // unreadable page: screening decides, as before
      }
      // The feed leaves the company out: without it the same-company check below can't see an earlier application.
      if (!row.company && reqs.company) { ctx.store.setCompany(row.id, reqs.company); row.company = reqs.company; }
      const verdict = djinniCheck(reqs, ctx.cfg.prefilter.djinni);
      if (verdict.pass) continue;
      ctx.store.transition(row.id, 'filtered', verdict.reason);
      summary.filtered.djinni = (summary.filtered.djinni ?? 0) + 1;
      dropped++;
    }
    if (onDjinni.length) say(`Djinni requirements: ${onDjinni.length} checked, ${dropped} you can't reply to (years or countries)`);
  }

  const setAside = (row: VacancyRow): boolean => {
    if (manualIds.includes(row.id) || ctx.store.markedByHand(row.id)) return false;
    const { earlier: hit, repost } = recheck(row);
    if (repost) { if (row.status === 'triage_pending') screenAgain(row, repost); return false; }
    if (!hit) return false;
    ctx.store.transition(row.id, 'filtered', `already applied to ${hit.name}: ${hit.link}`);
    summary.filtered['already applied to this company'] = (summary.filtered['already applied to this company'] ?? 0) + 1;
    summary.sameCompany.push({ ...listed(row, hit.name), earlier: hit.link });
    return true;
  };
  for (const row of ctx.store.byStatus(['triage_pending', 'shortlisted', 'tailor_pending']).filter(inScope)) {
    if (setAside(row)) continue;
    // Queued before the seniority rule existed (or rule changed since): drop titles below it for free too.
    const bySeniority = seniorityCheck(row.title, ctx.cfg.pipeline.minSeniority);
    if (row.status === 'triage_pending' && !bySeniority.pass && !manualIds.includes(row.id) && !ctx.store.markedByHand(row.id)) {
      ctx.store.transition(row.id, 'filtered', bySeniority.reason);
      summary.filtered.title = (summary.filtered.title ?? 0) + 1;
    }
  }

  if (opts.stage !== 'tailor' && !onlyIds) {
    const folded = foldTwins(ctx.store, inScope);
    if (folded) summary.filtered['same posting'] = folded;
  }

  const dropped = droppedCount(summary.filtered);
  const boardTitles = summary.filtered['board titles'] ?? 0;
  if (summary.reposted.length) say(`Posted again long after you applied — screened again: ${summary.reposted.map((r) => `${who(r)} (${r.reason.replace(/^reposted: /, '').replace(/ — .*/, '')})`).join('; ')}`);
  if (newRows.length || dropped) say(`Free filters: ${dropped} dropped (title, location, years, age, already applied, same posting in another city)${boardTitles ? ` · ${boardTitles} company-board jobs skipped by title, the same ones every run` : ''}`);

  const toTriage = opts.stage === 'tailor' ? [] : queued('triage_pending', ctx.cfg.pipeline.maxTriagePerRun);
  if (toTriage.length) say(`Screening ${toTriage.length} vacancies with the model…`);
  let screened = 0;
  await pool(toTriage, ctx.cfg.pipeline.concurrency, async (row) => {
    if (halted()) return;
    try {
      const injection = detectInjection(row.text);
      const { data } = await ctx.llm.call<Triage>({
        stage: 'triage', vacancyId: row.id, toolName: 'submit_triage',
        toolDescription: 'Return the screening verdict for this vacancy.',
        schema: TriageSchema, system: ctx.prompts.triage.text, coerce: coerceTriage,
        promptVersion: ctx.prompts.triage.version, promptHash: ctx.prompts.triage.hash,
        user: vacancyBlock(row),
        semanticCheck: (d) => d.lead_with.filter((id) => !ctx.k.engagements.has(id)).map((id) => `lead_with: "${id}" is not an engagement id`),
      });
      const verdict = decide(data, injection, ctx.cfg.pipeline, row, ctx.k.location.commuteCities);
      // A vacancy you added or pasted yourself is already your pick: it goes straight on to the CV.
      if (verdict.status === 'tailor_pending' && ctx.cfg.pipeline.approveBeforeTailor && (!onlyIds || opts.shortlistOnly)) verdict.status = 'shortlisted';
      ctx.store.transition(row.id, verdict.status, verdict.reason, { score: data.score, triage_json: JSON.stringify(data) });
      const fresh = ctx.store.get(row.id)!;
      const word = { tailor_pending: 'apply', shortlisted: 'apply?', needs_review: 'check', rejected: 'reject' }[verdict.status as string] ?? verdict.status;
      say(`  ${String(++screened).padStart(2)}/${toTriage.length}  ${String(data.score).padStart(3)} ${word.padEnd(10)} ${who(row)}`);
      if (verdict.status === 'shortlisted') { summary.triaged.apply++; summary.shortlisted.push(listed(fresh, verdict.reason)); }
      else if (verdict.status === 'tailor_pending') summary.triaged.apply++;
      else if (verdict.status === 'needs_review') { summary.triaged.review++; }
      else { summary.triaged.reject++; summary.rejected.push(listed(fresh, verdict.reason)); }
    } catch (e) {
      handleFailure(ctx, row, e, summary, 'triage_pending');
    }
  });

  const toTailor = halted() ? [] : queued('tailor_pending', ctx.cfg.pipeline.maxTailorPerRun);
  if (toTailor.length) say(`Writing CV, cover letter and recruiter message for ${toTailor.length} vacancies…`);
  const pitch = pitchRules(ctx.cfg.pipeline.recruiterMessage);
  let written = 0;
  await pool(toTailor, ctx.cfg.pipeline.concurrency, async (row) => {
    if (halted()) return;
    if (isCardOnly(row.text)) { // approved before its posting was read: there is nothing to tailor the CV to yet
      ctx.store.transition(row.id, 'shortlisted', 'a CV needs the posting itself: paste its text on the dashboard');
      return;
    }
    try {
      const triage: Triage = JSON.parse(row.triage_json ?? '{}');
      const lang: 'en' | 'uk' = triage.posting_language === 'uk' || row.lang === 'uk' ? 'uk' : 'en';
      const wanted = postingWants(row.title, row.text);
      const family = cvFamily(triage.role_family, wanted, ctx.k.families);
      const k = forVacancy(ctx.k, wanted);
      const frameworks = ctx.k.profile.engagements.filter((e) => e.frameworks).map((e) => `${e.id} → ${frameworksFor(e, wanted).join(', ')}`);
      const allowed = [...excludedFor(ctx.k.families.get(family))].filter((id) => wanted.has(id)).map(labelOf);
      const task = [
        '<task>',
        `cover_letter_language: ${lang === 'uk' ? 'Ukrainian' : 'English'} (the recruiter message too)`,
        `role_family: ${family}`,
        `role: ${row.title}${row.company ? ` at ${row.company}` : ''}`,
        `screening: matched=${JSON.stringify(triage.matched_requirements ?? [])}; lead_with=${JSON.stringify(triage.lead_with ?? [])}; seniority=${triage.seniority ?? 'unknown'}`,
        ...(frameworks.length ? [`framework: ${frameworks.join('; ')}`] : []),
        ...(allowed.length ? [`vacancy_asks_for: ${allowed.join(', ')} — allowed here despite the ${family} never-mention list`] : []),
        '</task>',
      ].join('\n');
      const { data: drafted, issues } = await ctx.llm.call<Plan>({
        stage: 'tailor', vacancyId: row.id, toolName: 'submit_edit_plan',
        toolDescription: 'Return the CV edit plan, the cover-letter slots and the recruiter message for this vacancy.',
        schema: makePlanSchema(ctx.k, pitch), coerce: (raw) => coercePlan(raw, pitch),
        system: ctx.prompts.tailor.text,
        promptVersion: ctx.prompts.tailor.version, promptHash: ctx.prompts.tailor.hash,
        user: vacancyBlock(row, task),
        semanticCheck: (plan) => validatePlan(plan, k, lang, family, wanted, pitch),
      });
      // The message's closing line is fixed, like the letter's: the model left it out more often than not.
      const closing = ctx.cfg.pipeline.recruiterMessage.closing[lang];
      const rm = drafted.recruiter_message;
      const data: Plan = rm && closing ? { ...drafted, recruiter_message: { note: rm.note, message: `${rm.message.trim()} ${closing}` } } : drafted;
      const pack = await renderPack(ctx, k, row, data, triage, lang, family, issues, wanted);
      const status: Status = pack.issues.length > 0 ? 'needs_review' : 'ready';
      ctx.store.transition(row.id, status, pack.issues[0] ?? 'pack ready', { plan_json: JSON.stringify(data), pack_dir: pack.dir });
      say(`  ${String(++written).padStart(2)}/${toTailor.length}  ${status === 'ready' ? 'ready       ' : 'needs review'} ${who(row)}\n         → ${path.relative(process.cwd(), pack.dir)}`);
      summary.packs.push({
        id: row.id, title: row.title, company: row.company, url: row.url, score: row.score,
        dir: pack.dir, status, issues: pack.issues, why: triage.matched_requirements ?? [],
      });
    } catch (e) {
      handleFailure(ctx, row, e, summary, 'tailor_pending');
    }
  });

  if (opts.stop?.requested && !summary.stopped) summary.stopped = 'stopped by you (Ctrl+C) — everything not reached waits for the next run';
  summary.pending.triage = ctx.store.byStatus(['triage_pending']).length;
  summary.pending.approve = ctx.store.byStatus(['shortlisted']).length;
  summary.pending.tailor = ctx.store.byStatus(['tailor_pending']).length;
  summary.finishedAt = ctx.now().toISOString();
  return summary;
}

/**
 * Job-alert emails (LinkedIn, Glassdoor, Indeed, Jobs.cz, Djinni) → a list of links, grouped by the email they came in.
 * Nothing here is screened or looked up: you open the posting (or the email) and decide. Each email is read once; a job
 * already known — from a feed, an earlier email or your applied list — isn't listed again.
 */
async function readAlerts(ctx: Ctx, mail: MailSource, applied: Set<string>, summary: RunSummary, say: (line: string) => void): Promise<void> {
  const since = new Date(ctx.now().getTime() - ctx.cfg.alerts.lookbackDays * 86_400_000);
  const mails = (await mail.fetch(since, (id) => Boolean(ctx.store.aliasGet(`mail:${id}`)))).filter((m) => !ctx.store.aliasGet(`mail:${m.id}`));
  say(`Reading alert emails: ${mails.length} new in the last ${ctx.cfg.alerts.lookbackDays} days`);
  if (!mails.length) return;
  const earlier = await appliedCompanies(ctx, appliedEntries(ctx));
  const extract = limited(Math.max(ctx.cfg.pipeline.concurrency, 4), (m: AlertMail) => extractJobs(ctx, m));
  const extracted = mails.map((m) => {
    const p = extract(m);
    p.catch(() => {}); // awaited below, in order; this only keeps an early failure from going unhandled meanwhile
    return p;
  });
  // Emails that fail are not remembered, so the next run reads them again. Once the extract model's circuit is open
  // the rest wait for the next run too — one line for all of them, and screening (on its own model) still goes ahead.
  let unread = 0;
  let unreadWhy = '';
  for (const [i, m] of mails.entries()) {
    let jobs;
    try {
      jobs = await extracted[i];
    } catch (e) {
      if (e instanceof LlmError && e.kind === 'budget') { summary.stopped = `${e.kind}: ${e.message}`; return; }
      if (e instanceof LlmError && e.kind === 'circuit_open') { unread++; unreadWhy = e.message; continue; }
      summary.sourceErrors.push({ source: `alert email "${m.subject.slice(0, 60)}"`, error: (e as Error).message.slice(0, 300) });
      continue;
    }
    ctx.store.alertMailSet({ id: m.id, sender: m.from, subject: m.subject, date: m.date });
    let listedNow = 0;
    let known = 0;
    for (const job of jobs) {
      summary.discovered++;
      const link = await alertLink(ctx, job);
      if (ctx.store.get(link.key) || ctx.store.aliasGet(link.key)) { known++; continue; }
      if (applied.has(link.key)) { ctx.store.aliasSet(link.key, null, 'already applied (tracking sheet)'); known++; continue; }
      const company = cleanLine(job.company);
      const { earlier: hit, repost } = earlierApplication(earlier, { company, url: link.url, title: cleanLine(job.title) ?? '' }, { days: ctx.cfg.pipeline.repostAfterDays, now: ctx.now() });
      const note = repost ? repostNote(repost.at, ctx.now(), repost.link) : hit ? `already applied to ${hit.name}: ${hit.link}` : null;
      ctx.store.insertIfNew({
        id: link.key, source: `alert-${job.via}`, url: link.url, title: cleanLine(job.title) ?? 'Untitled role', company,
        location: cleanLine(job.location), text: '', lang: null, posted_at: m.date, status: 'external', status_reason: note, mail_id: m.id,
      });
      summary.alertJobs.push({ url: link.url, title: job.title, company: job.company, location: job.location, via: job.via, note });
      listedNow++;
    }
    ctx.store.aliasSet(`mail:${m.id}`, null, `${jobs.length} jobs from ${m.from}`);
    say(`  email ${i + 1}/${mails.length} (${m.from.split('@')[1] ?? m.from}): ${jobs.length} jobs, ${listedNow} new${known ? ` (${known} seen before)` : ''}`);
  }
  if (unread) summary.sourceErrors.push({ source: 'alert emails', error: `${unread} left for the next run — ${unreadWhy}` });
}

/**
 * Free and repeatable: earlier verdicts are decided again from the stored screening under today's rules, so a lower
 * threshold or a fixed rule reaches vacancies already screened. Only recent rejected/borderline ones can move up (to
 * your shortlist), never down. Alert jobs left from when they were screened go back to the alert list.
 */
export function redecide(ctx: Ctx): number {
  const cutoff = ctx.now().getTime() - ctx.cfg.pipeline.maxAgeDays * 86_400_000;
  let moved = 0;
  for (const row of ctx.store.byStatus(['rejected', 'borderline', 'new', 'triage_pending'], 100_000)) {
    if (row.source.startsWith('alert-')) {
      if (!ctx.store.markedByHand(row.id)) ctx.store.transition(row.id, 'external', row.status === 'borderline' || row.status === 'rejected' ? null : row.status_reason);
      continue;
    }
    if (row.status !== 'rejected' && row.status !== 'borderline') continue;
    if (Date.parse(row.posted_at ?? row.discovered_at) < cutoff) continue; // an old posting is likely filled: left as it was
    let t: Triage;
    try { t = TriageSchema.parse(coerceTriage(JSON.parse(row.triage_json ?? 'null'))); } catch { continue; }
    const verdict = decide(t, detectInjection(row.text), ctx.cfg.pipeline, row, ctx.k.location.commuteCities);
    if (verdict.status === 'tailor_pending') {
      ctx.store.transition(row.id, 'shortlisted', `${verdict.reason} (re-decided)`);
      moved++;
    } else if (row.status === 'borderline') ctx.store.transition(row.id, 'rejected', verdict.reason);
  }
  return moved;
}

/** Board jobs with other titles are recounted on every run, so they stay out of what a run actually dropped. */
export const droppedCount = (filtered: Record<string, number>): number =>
  Object.entries(filtered).reduce((sum, [reason, n]) => (reason === 'board titles' ? sum : sum + n), 0);

function handleFailure(ctx: Ctx, row: VacancyRow, e: unknown, summary: RunSummary, stayAt: 'triage_pending' | 'tailor_pending'): void {
  if (e instanceof LlmError && (e.kind === 'budget' || e.kind === 'circuit_open')) {
    summary.stopped = `${e.kind}: ${e.message}`;
    ctx.log.warn({ err: e.message }, 'stopping LLM stages for this run');
    return;
  }
  const attempts = row.attempts + 1;
  const message = (e as Error).message.slice(0, 300);
  summary.failures.push(`${row.title}: ${message.slice(0, 120)}`);
  ctx.log.error({ vacancyId: row.id, attempts, err: message }, 'vacancy failed');
  summary.failed++;
  if (attempts >= ctx.cfg.pipeline.maxAttempts) ctx.store.transition(row.id, 'failed', message, { attempts });
  else ctx.store.transition(row.id, stayAt, `attempt ${attempts} failed: ${message}`, { attempts });
}

async function renderPack(ctx: Ctx, k: Knowledge, row: VacancyRow, plan: Plan, triage: Triage, lang: 'en' | 'uk', family: RoleFamily, planIssues: string[], wanted: Set<string>): Promise<{ dir: string; issues: string[] }> {
  const day = ctx.now().toISOString().slice(0, 10);
  const dir = path.join(ctx.cfg.paths.out, 'packs', `${day}__${slug(row.id, 24)}__${slug(`${row.company ?? ''}-${row.title}`, 60)}`);
  fs.mkdirSync(dir, { recursive: true });
  const issues = [...planIssues];

  // Recruiters see attachment names, so they carry the candidate's name and nothing about tailoring.
  const files = packFileNames(ctx.k.profile.person.name);
  const htmlFile = path.join(dir, files.cvHtml);
  const pdfFile = path.join(dir, files.cvPdf);
  fs.writeFileSync(htmlFile, renderCvHtml(k, plan, ctx.css, family, wanted));
  const pdf = await htmlToPdf(htmlFile, pdfFile, ctx.cfg.render);
  if (pdf.error) issues.push(`PDF: ${pdf.error}`);
  if (pdf.pages && pdf.pages > ctx.cfg.render.maxPages) issues.push(`CV is ${pdf.pages} pages (max ${ctx.cfg.render.maxPages})`);

  const letter = composeLetter(plan.cover_letter, lang, ctx.letterBase, row.title);
  await writeLetterDocx(path.join(dir, files.letterDocx), letter.subject, letter.paragraphs);
  fs.writeFileSync(path.join(dir, 'cover_letter.txt'), letterText(letter.paragraphs));
  if (plan.recruiter_message) {
    const { note, message } = plan.recruiter_message;
    fs.writeFileSync(path.join(dir, 'recruiter_message.txt'), `Connection note (${note.length} characters)\n\n${note}\n\n---\n\nDirect message (${message.length} characters)\n\n${message}\n`);
  }

  fs.writeFileSync(path.join(dir, 'vacancy.md'), `# ${row.title}\n\n- Company: ${row.company ?? 'unknown'}\n- Location: ${row.location ?? 'unknown'}\n- Link: ${row.url}\n- Source: ${row.source}\n\n---\n\n${row.text}\n`);
  fs.writeFileSync(path.join(dir, 'decision.json'), JSON.stringify({
    vacancy: { id: row.id, url: row.url, title: row.title, company: row.company, lang: row.lang },
    roleFamily: family, triage, plan, issues, pdfPages: pdf.pages,
    prompts: { triage: { version: ctx.prompts.triage.version, hash: ctx.prompts.triage.hash }, tailor: { version: ctx.prompts.tailor.version, hash: ctx.prompts.tailor.hash } },
    models: { triage: ctx.cfg.llm.stages.triage.model, tailor: ctx.cfg.llm.stages.tailor.model },
    runId: ctx.runId, at: ctx.now().toISOString(),
  }, null, 2));

  return { dir, issues };
}
