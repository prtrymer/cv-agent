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
import { extractJobs, resolveAlertJob, type Unresolved } from '../sources/alerts.js';
import { ImapMailSource, type AlertMail, type MailSource } from '../sources/mail.js';
import type { Board } from '../ats/boards.js';
import type { VacancyRow } from '../store/db.js';
import type { RawVacancy, RoleFamily, Status } from '../types.js';
import { politeFetch } from '../util/http.js';
import { djinniCheck, parseDjinniRequirements, type DjinniRequirements } from '../sources/djinni.js';
import { limited, pool } from '../util/pool.js';
import { cleanLine, detectInjection, detectLang, htmlToText, sanitizeUntrusted, slug } from '../util/text.js';
import { canonicalize } from '../util/url.js';
import { belowMiddle, prefilter } from './prefilter.js';
import { coercePlan, makePlanSchema } from './tailor.js';
import { appliedCompanies, sameCompanyAs } from './applied.js';
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
  triaged: { apply: number; borderline: number; reject: number; review: number };
  packs: PackInfo[];
  rejected: Listed[];
  borderline: Listed[];
  /** Screening said apply; waiting for your go (pipeline.approveBeforeTailor). */
  shortlisted: Listed[];
  failed: number;
  stopped: string | null;
  sourceErrors: Array<{ source: string; error: string }>;
  pending: { triage: number; approve: number; tailor: number };
  failures: string[];
  /** Set aside before any model call: you already applied to this company (with the earlier link). */
  sameCompany: Array<Listed & { earlier: string }>;
  /** Alert jobs that exist only on LinkedIn/Glassdoor as far as the agent can tell — yours to apply to by hand. */
  unresolved: Unresolved[];
}

/** "Anton Chaika" → Anton_Chaika_CV.pdf, Anton_Chaika_Cover_Letter.docx. */
export function packFileNames(personName: string): { cvHtml: string; cvPdf: string; letterDocx: string } {
  const stem = personName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'CV';
  return { cvHtml: `${stem}_CV.html`, cvPdf: `${stem}_CV.pdf`, letterDocx: `${stem}_Cover_Letter.docx` };
}

/** Does a stored vacancy come from one of these source ids? `watchlist` covers company boards, `alerts` alert emails. */
export function fromSources(ids: string[], rowSource: string): boolean {
  return ids.includes(rowSource) || (ids.includes('watchlist') && rowSource.startsWith('ats-')) || (ids.includes('alerts') && rowSource.startsWith('alert-'));
}

const listed = (row: VacancyRow, reason: string): Listed => ({ id: row.id, title: row.title, company: row.company, url: row.url, score: row.score, reason });

/** One line of the tracking file: a link, optionally followed by `# Company` for links that don't name one. */
export function parseAppliedLine(line: string): { url: string; company: string | null } | null {
  const [url, note] = line.trim().split(/\s+#\s*/, 2);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return { url, company: note?.trim() || null };
}

export const appliedEntries = (ctx: Ctx): Array<{ url: string; company: string | null }> => (fs.existsSync(ctx.cfg.paths.appliedSeed)
  ? fs.readFileSync(ctx.cfg.paths.appliedSeed, 'utf8').split('\n').map(parseAppliedLine).filter((e): e is { url: string; company: string | null } => e !== null)
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

export function ingest(ctx: Ctx, raw: RawVacancy, applied: Set<string>, summary: RunSummary): void {
  const canon = canonicalize(raw.url);
  if (!canon) { ctx.log.warn({ url: raw.url }, 'unusable vacancy link, skipped'); return; }
  const body = raw.descriptionText ?? (raw.descriptionHtml ? htmlToText(raw.descriptionHtml) : '');
  const text = sanitizeUntrusted(body, ctx.cfg.pipeline.vacancyCharLimit);
  const title = cleanLine(raw.title) ?? 'Untitled role';
  const alreadyApplied = applied.has(canon.key);
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
    status_reason: alreadyApplied ? 'already applied (tracking sheet)' : null,
  });
  if (!inserted) return;
  summary.fresh++;
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
  /** One human-readable line per step (the CLI prints them; logs keep the detail). */
  say?: (line: string) => void;
}

export async function runPipeline(ctx: Ctx, opts: RunOptions = {}): Promise<RunSummary> {
  const summary: RunSummary = {
    runId: ctx.runId, mode: ctx.cfg.mode, startedAt: ctx.now().toISOString(), finishedAt: '',
    discovered: 0, fresh: 0, filtered: {}, triaged: { apply: 0, borderline: 0, reject: 0, review: 0 },
    packs: [], rejected: [], borderline: [], shortlisted: [], failed: 0, stopped: null, sourceErrors: [], pending: { triage: 0, approve: 0, tailor: 0 }, unresolved: [], failures: [], sameCompany: [],
  };
  const applied = loadAppliedKeys(ctx);
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
      if (raw.descriptionText) {
        const text = sanitizeUntrusted(raw.descriptionText, ctx.cfg.pipeline.vacancyCharLimit);
        ctx.store.setText(row.id, text, detectLang(`${row.title}\n${text}`));
      }
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
        for (const raw of raws) ingest(ctx, raw, applied, summary);
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
          for (const raw of board.jobs) ingest(ctx, raw, applied, summary);
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

  const newRows = opts.stage === 'tailor' ? [] : ctx.store.byStatus(['new']);
  for (const row of newRows) {
    const result = prefilter(row, ctx.cfg.prefilter, ctx.k.location);
    if (result.pass) ctx.store.transition(row.id, 'triage_pending', null);
    else {
      ctx.store.transition(row.id, 'filtered', result.reason);
      const bucket = result.reason.split(':')[0];
      summary.filtered[bucket] = (summary.filtered[bucket] ?? 0) + 1;
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

  // Never spend a model call (or send a CV) on a company you already applied to, unless you sent it on by hand.
  const earlierApps = await appliedCompanies(ctx, appliedEntries(ctx));
  const setAside = (row: VacancyRow): boolean => {
    if (manualIds.includes(row.id) || ctx.store.markedByHand(row.id)) return false;
    const hit = sameCompanyAs(earlierApps, row);
    if (!hit) return false;
    ctx.store.transition(row.id, 'filtered', `already applied to ${hit.name}: ${hit.link}`);
    summary.filtered['already applied to this company'] = (summary.filtered['already applied to this company'] ?? 0) + 1;
    summary.sameCompany.push({ ...listed(row, hit.name), earlier: hit.link });
    return true;
  };
  for (const row of ctx.store.byStatus(['triage_pending', 'tailor_pending']).filter(inScope)) {
    if (setAside(row)) continue;
    // Queued before the seniority rule existed (or rule changed since): drop trainee/junior titles for free too.
    if (row.status === 'triage_pending' && ctx.cfg.prefilter.skipJuniorTitles && belowMiddle(row.title) && !manualIds.includes(row.id) && !ctx.store.markedByHand(row.id)) {
      ctx.store.transition(row.id, 'filtered', 'title: trainee / intern / junior role');
      summary.filtered.title = (summary.filtered.title ?? 0) + 1;
    }
  }

  const dropped = Object.values(summary.filtered).reduce((a, b) => a + b, 0);
  if (newRows.length || dropped) say(`Free filters: ${dropped} dropped (title, location, years, age, already applied)`);

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
      const verdict = decide(data, injection, ctx.cfg.pipeline);
      // A vacancy you added or pasted yourself is already your pick: it goes straight on to the CV.
      if (verdict.status === 'tailor_pending' && ctx.cfg.pipeline.approveBeforeTailor && !onlyIds) verdict.status = 'shortlisted';
      ctx.store.transition(row.id, verdict.status, verdict.reason, { score: data.score, triage_json: JSON.stringify(data) });
      const fresh = ctx.store.get(row.id)!;
      const word = { tailor_pending: 'apply', shortlisted: 'apply?', borderline: 'borderline', needs_review: 'check', rejected: 'reject' }[verdict.status as string] ?? verdict.status;
      say(`  ${String(++screened).padStart(2)}/${toTriage.length}  ${String(data.score).padStart(3)} ${word.padEnd(10)} ${who(row)}`);
      if (verdict.status === 'shortlisted') { summary.triaged.apply++; summary.shortlisted.push(listed(fresh, verdict.reason)); }
      else if (verdict.status === 'tailor_pending') summary.triaged.apply++;
      else if (verdict.status === 'borderline') { summary.triaged.borderline++; summary.borderline.push(listed(fresh, verdict.reason)); }
      else if (verdict.status === 'needs_review') { summary.triaged.review++; }
      else { summary.triaged.reject++; summary.rejected.push(listed(fresh, verdict.reason)); }
    } catch (e) {
      handleFailure(ctx, row, e, summary, 'triage_pending');
    }
  });

  const toTailor = halted() ? [] : queued('tailor_pending', ctx.cfg.pipeline.maxTailorPerRun);
  if (toTailor.length) say(`Writing CV + cover letter for ${toTailor.length} vacancies…`);
  let written = 0;
  await pool(toTailor, ctx.cfg.pipeline.concurrency, async (row) => {
    if (halted()) return;
    try {
      const triage: Triage = JSON.parse(row.triage_json ?? '{}');
      const lang: 'en' | 'uk' = triage.posting_language === 'uk' || row.lang === 'uk' ? 'uk' : 'en';
      // A vacancy pushed here by hand (`mark … tailor`) may carry a family out of scope; it gets the fullstack CV.
      const family: RoleFamily = triage.role_family && triage.role_family !== 'other' && ctx.k.families.has(triage.role_family) ? triage.role_family : 'fullstack';
      // What the posting asks for lifts the family's never-mention list: a "Node.js + Java" backend role may say Java.
      const wanted = detectTech(`${row.title}\n${row.text}`);
      const k = forVacancy(ctx.k, wanted);
      const frameworks = ctx.k.profile.engagements.filter((e) => e.frameworks).map((e) => `${e.id} → ${frameworksFor(e, wanted).join(', ')}`);
      const allowed = [...excludedFor(ctx.k.families.get(family))].filter((id) => wanted.has(id)).map(labelOf);
      const task = [
        '<task>',
        `cover_letter_language: ${lang === 'uk' ? 'Ukrainian' : 'English'}`,
        `role_family: ${family}`,
        `role: ${row.title}${row.company ? ` at ${row.company}` : ''}`,
        `screening: matched=${JSON.stringify(triage.matched_requirements ?? [])}; lead_with=${JSON.stringify(triage.lead_with ?? [])}; seniority=${triage.seniority ?? 'unknown'}`,
        ...(frameworks.length ? [`framework: ${frameworks.join('; ')}`] : []),
        ...(allowed.length ? [`vacancy_asks_for: ${allowed.join(', ')} — allowed here despite the ${family} never-mention list`] : []),
        '</task>',
      ].join('\n');
      const { data, issues } = await ctx.llm.call<Plan>({
        stage: 'tailor', vacancyId: row.id, toolName: 'submit_edit_plan',
        toolDescription: 'Return the CV edit plan and cover-letter slots for this vacancy.',
        schema: makePlanSchema(ctx.k), coerce: coercePlan,
        system: ctx.prompts.tailor.text,
        promptVersion: ctx.prompts.tailor.version, promptHash: ctx.prompts.tailor.hash,
        user: vacancyBlock(row, task),
        semanticCheck: (plan) => validatePlan(plan, k, lang, family, wanted),
      });
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
 * LinkedIn/Glassdoor alert emails → jobs → the same jobs on company boards. Each email is read once. The model reads
 * a few emails ahead while the jobs of earlier ones are looked up on company boards, one email at a time.
 */
async function readAlerts(ctx: Ctx, mail: MailSource, applied: Set<string>, summary: RunSummary, say: (line: string) => void): Promise<void> {
  const since = new Date(ctx.now().getTime() - ctx.cfg.alerts.lookbackDays * 86_400_000);
  const boards = new Map<string, Board | null>();
  const mails = (await mail.fetch(since, (id) => Boolean(ctx.store.aliasGet(`mail:${id}`)))).filter((m) => !ctx.store.aliasGet(`mail:${m.id}`));
  say(`Reading alert emails: ${mails.length} new in the last ${ctx.cfg.alerts.lookbackDays} days`);
  const extract = limited(Math.max(ctx.cfg.pipeline.concurrency, 4), (m: AlertMail) => extractJobs(ctx, m));
  const extracted = mails.map((m) => {
    const p = extract(m);
    p.catch(() => {}); // awaited below, in order; this only keeps an early failure from going unhandled meanwhile
    return p;
  });
  for (const [i, m] of mails.entries()) {
    let jobs;
    try {
      jobs = await extracted[i];
    } catch (e) {
      if (e instanceof LlmError && (e.kind === 'budget' || e.kind === 'circuit_open')) { summary.stopped = `${e.kind}: ${e.message}`; return; }
      summary.sourceErrors.push({ source: `alert email "${m.subject.slice(0, 60)}"`, error: (e as Error).message.slice(0, 300) });
      continue; // not remembered, so the next run tries this email again
    }
    const before = summary.fresh;
    for (const job of jobs) {
      summary.discovered++;
      const r = await resolveAlertJob(ctx, job, applied, boards);
      if (r.kind === 'resolved') ingest(ctx, r.vacancy, applied, summary);
      else if (r.kind === 'unresolved') {
        summary.unresolved.push({ url: r.url, title: job.title, company: job.company, location: job.location, reason: r.reason });
        // Kept on the dashboard ("Only on LinkedIn & co"): apply there yourself, or paste the posting text for a CV.
        const key = canonicalize(r.url)?.key;
        if (key && !ctx.store.get(key)) {
          ctx.store.insertIfNew({ id: key, source: `alert-${job.via}`, url: canonicalize(r.url)!.url, title: cleanLine(job.title) ?? 'Untitled role', company: cleanLine(job.company), location: cleanLine(job.location), text: '', lang: null, posted_at: m.date, status: 'external', status_reason: r.reason });
        }
      }
      else if (r.kind === 'filtered') {
        const bucket = r.reason.split(':')[0];
        summary.filtered[bucket] = (summary.filtered[bucket] ?? 0) + 1;
      }
    }
    ctx.store.aliasSet(`mail:${m.id}`, null, `${jobs.length} jobs from ${m.from}`);
    say(`  email ${i + 1}/${mails.length} (${m.from.split('@')[1] ?? m.from}): ${jobs.length} jobs, ${summary.fresh - before} new`);
  }
}

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
