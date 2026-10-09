import { gunzipSync } from 'node:zlib';
import { convert } from 'html-to-text';
import { z } from 'zod';
import { fetchBoard, type Board } from '../ats/boards.js';
import { findBoard, matchPosting } from '../ats/resolve.js';
import type { Ctx } from '../ctx.js';
import { locationCheck, titleCheck } from '../pipeline/prefilter.js';
import type { RawVacancy } from '../types.js';
import { sha256 } from '../util/hash.js';
import { politeFetch } from '../util/http.js';
import { sanitizeUntrusted } from '../util/text.js';
import { canonicalize } from '../util/url.js';
import { extractJobPosting } from './manual.js';
import type { AlertMail } from './mail.js';

/**
 * A job link found in an alert email. `key` is its canonical id when the link could be read offline; an opaque
 * tracker (Jobs.cz encrypts its links) has none until it is followed. `lines` are the email lines it appears on.
 */
export interface JobLink { token: string; url: string; key: string | null; lines: string[] }
export interface AlertJob { url: string; key: string | null; title: string; company: string; location: string | null; via: string }
export interface Unresolved { url: string; title: string; company: string; location: string | null; reason: string }

const EMAIL_CHAR_LIMIT = 14_000;
/** Sites whose job pages the agent never opens: the job is looked up on the company's own board instead. */
const LOOKUP_ONLY = /^(linkedin|glassdoor|indeed|jobscz):/;
const JOB_KEY = /^(linkedin|glassdoor|indeed|djinni|jobscz):/;
const OPAQUE = /^https?:\/\/track\.jobs\.cz\//i;

const b64 = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Click trackers that carry the real destination inside the link: read it without following the link. */
export function decodeTracker(href: string): string {
  try {
    const u = new URL(href);
    if (u.hostname === 'mandrillapp.com' && u.pathname.startsWith('/track/click')) { // Djinni
      const o = JSON.parse(b64(u.searchParams.get('p') ?? '').toString('utf8'));
      const inner = typeof o.p === 'string' ? JSON.parse(o.p) : o;
      if (typeof inner.url === 'string') return inner.url;
    }
    if (/(^|\.)indeed\.com$/.test(u.hostname) && u.pathname.startsWith('/v3/')) { // Indeed: base64url(gzip(JSON))
      const o = JSON.parse(gunzipSync(b64(u.pathname.split('/')[2] ?? '')).toString('utf8'));
      if (typeof o.u === 'string') return o.u;
    }
    for (const k of ['url', 'u', 'redirect', 'dest', 'target']) {
      const v = u.searchParams.get(k);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
  } catch { /* not a tracker we can read */ }
  return href;
}

/**
 * Alert email → plain text in which every job link is replaced by a short token ("job 3") and every other link is
 * dropped, plus the token → link table. Code decides what a job link is; the model only matches cards to tokens.
 */
export function readAlertEmail(mail: AlertMail): { text: string; links: JobLink[] } {
  const raw = mail.html
    ? convert(mail.html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }, { selector: 'style', format: 'skip' }] })
    : mail.text;
  const links: JobLink[] = [];
  const byKey = new Map<string, string>();
  const text = raw
    .replace(/https?:\/\/[^\s<>\])"]+/g, (href) => {
      const real = decodeTracker(href);
      const c = canonicalize(real);
      if (c && JOB_KEY.test(c.key)) {
        const known = byKey.get(c.key);
        if (known) return known;
        const token = `job ${links.length + 1}`;
        byKey.set(c.key, token);
        links.push({ token, url: c.url, key: c.key, lines: [] });
        return token;
      }
      if (OPAQUE.test(real)) {
        const token = `job ${links.length + 1}`;
        links.push({ token, url: real, key: null, lines: [] });
        return token;
      }
      return '';
    })
    .replace(/\[\s*\]|<\s*>/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const lines = text.split('\n');
  for (const l of links) l.lines = lines.filter((x) => new RegExp(`\\b${l.token}\\b`).test(x));
  return { text: sanitizeUntrusted(text, EMAIL_CHAR_LIMIT), links: links.filter((l) => l.lines.length) };
}

const squash = (s: string): string => s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();

/**
 * The job cards in one alert email. The model matches each card to a token; code then checks that the title and
 * company are in the email and — for opaque links, which have to be followed — that the token sits on the title's
 * own line, so an unsubscribe or settings link can never be taken for a job and followed.
 */
export async function extractJobs(ctx: Ctx, mail: AlertMail): Promise<AlertJob[]> {
  const { text, links } = readAlertEmail(mail);
  if (links.length === 0) return [];
  const byToken = new Map(links.map((l) => [l.token, l]));
  const schema = z.object({
    jobs: z.array(z.object({
      link: z.enum(links.map((l) => l.token) as [string, ...string[]]),
      title: z.string().min(2).max(200),
      company: z.string().min(1).max(120),
      location: z.string().max(200).nullable(),
    }).strict()).max(60),
  }).strict();
  type Out = z.infer<typeof schema>;
  const id = sha256(`${mail.id}\n${text}`).slice(0, 16);
  const haystack = squash(text);
  const problems = (j: Out['jobs'][number]): string[] => {
    const out: string[] = [];
    if (!haystack.includes(squash(j.title))) out.push(`title "${j.title}" is not in the email — copy it exactly`);
    if (!haystack.includes(squash(j.company))) out.push(`company "${j.company}" is not in the email — copy it exactly`);
    const l = byToken.get(j.link);
    if (l && l.key === null && !l.lines.some((x) => squash(x).includes(squash(j.title)))) out.push(`${j.link} is not on the line with "${j.title}" — use the token right after the title`);
    return out;
  };
  const { data, issues } = await ctx.llm.call<Out>({
    stage: 'extract', vacancyId: `mail:${id}`, toolName: 'submit_jobs',
    toolDescription: 'Return the job postings advertised in this alert email.',
    schema, system: ctx.prompts.extract.text,
    promptVersion: ctx.prompts.extract.version, promptHash: ctx.prompts.extract.hash,
    user: [`<email id="${id}" from="${mail.from}">`, `Subject: ${mail.subject}`, '---', text, '</email>'].join('\n'),
    semanticCheck: (d) => d.jobs.flatMap((j, i) => problems(j).map((p) => `jobs[${i}]: ${p}`)),
  });
  if (issues.length) ctx.log.warn({ mail: mail.id, issues }, 'alert extraction kept issues; dropping the jobs it could not ground');
  const via = viaOf(mail.from);
  const seen = new Set<string>();
  const out: AlertJob[] = [];
  for (const j of data.jobs) {
    const l = byToken.get(j.link);
    if (!l || seen.has(l.token) || problems(j).length) continue;
    seen.add(l.token);
    out.push({ url: l.url, key: l.key, title: j.title, company: j.company, location: j.location, via });
  }
  return out;
}

const viaOf = (from: string): string => {
  const d = from.toLowerCase();
  return d.includes('linkedin') ? 'linkedin' : d.includes('glassdoor') ? 'glassdoor' : d.includes('indeed') ? 'indeed' : d.includes('jobs.cz') ? 'jobscz' : d.includes('djinni') ? 'djinni' : 'email';
};

/** Reads where an opaque tracker points (the Location header only — the destination page is never opened). */
async function followTracker(url: string, ctx: Ctx): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(current, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': ctx.cfg.http.userAgent }, signal: AbortSignal.timeout(ctx.cfg.http.timeoutMs) });
    const next = res.headers.get('location');
    if (!next) return null;
    current = new URL(next, current).href;
    if (!OPAQUE.test(current)) return current;
  }
  return null;
}

export type ResolveOutcome =
  | { kind: 'known' } | { kind: 'filtered'; reason: string }
  | { kind: 'resolved'; vacancy: RawVacancy; board: string }
  | { kind: 'unresolved'; url: string; reason: string };

/**
 * One alert job → a vacancy the pipeline can work on. Djinni postings are read directly (their pages carry
 * schema.org JobPosting and the agent already reads Djinni). LinkedIn, Glassdoor, Indeed and Jobs.cz pages are never
 * opened: the same job is looked up on the company's own ATS board. Every outcome is remembered under the job's key.
 */
export async function resolveAlertJob(ctx: Ctx, job: AlertJob, applied: Set<string>, boards: Map<string, Board | null>): Promise<ResolveOutcome> {
  const t = titleCheck(job.title, ctx.cfg.prefilter);
  let key = job.key;
  let url = job.url;
  if (!key) {
    // Jobs.cz: only titles worth screening get their link resolved, and only to read the posting id.
    if (!t.pass) return { kind: 'filtered', reason: t.reason };
    const dest = await followTracker(job.url, ctx).catch(() => null);
    const c = dest ? canonicalize(dest) : null;
    if (!c) return { kind: 'unresolved', url: job.url, reason: 'could not read the job link' };
    ({ key, url } = c);
  }
  if (ctx.store.aliasGet(key) || ctx.store.get(key)) return { kind: 'known' };
  const remember = (vacancyId: string | null, note: string) => ctx.store.aliasSet(key!, vacancyId, note);

  if (applied.has(key)) { remember(null, 'already applied (tracking sheet)'); return { kind: 'filtered', reason: 'already applied' }; }
  if (!t.pass) { remember(null, t.reason); return { kind: 'filtered', reason: t.reason }; }
  // "Prague (On-site)" in the alert already fails the location rule: no need to look for the company's board.
  const where = job.location ? locationCheck(job.location, ctx.k.location) : { pass: true as const };
  if (!where.pass) { remember(null, where.reason); return { kind: 'filtered', reason: where.reason }; }
  const source = `alert-${job.via}`;

  if (key.startsWith('djinni:')) {
    try {
      const page = await politeFetch(url, ctx.cfg.http);
      const jp = extractJobPosting(page.text);
      if (!jp) return { kind: 'unresolved', url, reason: 'Djinni page has no job data' };
      remember(key, 'djinni posting');
      return { kind: 'resolved', board: 'djinni', vacancy: { source, url, title: jp.title, company: jp.company ?? job.company, location: jp.location ?? job.location, descriptionHtml: jp.descriptionHtml } };
    } catch (e) {
      return { kind: 'unresolved', url, reason: `could not read the Djinni posting (${(e as Error).message.slice(0, 60)})` };
    }
  }
  if (!LOOKUP_ONLY.test(key)) return { kind: 'unresolved', url, reason: 'unsupported link' };

  const ref = await findBoard(job.company, ctx.store, ctx.cfg.http, ctx.cfg.ats.probeTtlDays, ctx.now());
  if (!ref) { remember(null, 'company has no public job board'); return { kind: 'unresolved', url, reason: 'company has no board on a supported ATS' }; }
  const boardKey = `${ref.ats}/${ref.board}`;
  if (!boards.has(boardKey)) {
    try {
      boards.set(boardKey, await fetchBoard(ref, ctx.cfg.http, { keep: (title) => titleCheck(title, ctx.cfg.prefilter).pass }));
    } catch (e) {
      ctx.log.warn({ board: boardKey, err: (e as Error).message }, 'board fetch failed');
      boards.set(boardKey, null);
    }
  }
  const board = boards.get(boardKey);
  if (!board) return { kind: 'unresolved', url, reason: `could not read ${boardKey} this run` };
  const hit = matchPosting(board.jobs, job.title);
  if (!hit) { remember(null, `not on ${boardKey}`); return { kind: 'unresolved', url, reason: `no matching posting on ${boardKey}` }; }

  remember(canonicalize(hit.job.url)?.key ?? null, `${boardKey} (title match ${hit.score.toFixed(2)})`);
  return { kind: 'resolved', board: boardKey, vacancy: { ...hit.job, source, company: hit.job.company ?? board.company ?? job.company } };
}
