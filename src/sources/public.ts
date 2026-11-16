import { matchPosting, sameCompany } from '../ats/resolve.js';
import { HttpError, politeFetch, type HttpOptions } from '../util/http.js';
import { decodeEntities } from '../util/text.js';
import { canonicalize } from '../util/url.js';
import { extractJobPosting } from './manual.js';

/**
 * Public job pages, read logged out: no cookies, no account, so there is no account to ban. LinkedIn's guest job view
 * (what a signed-out visitor sees), Jobs.cz detail pages, and robota.ua vacancies through the JSON API its own site
 * calls (robota.ua's pages sit behind Cloudflare; api.rabota.ua does not). Glassdoor sits behind Cloudflare and is never fetched:
 * its jobs, and Indeed's, are looked up on LinkedIn's public job search by title and company instead.
 */
export interface PublicPosting { url: string; title: string; company: string | null; location: string | null; descriptionHtml: string }
export type PublicRead =
  | { kind: 'found'; posting: PublicPosting; via: string }
  /** The posting is gone or no longer takes applications. */
  | { kind: 'closed'; reason: string }
  /** No posting to read: screen the job on its alert card. */
  | { kind: 'missing'; reason: string }
  /** The site is pushing back (429, LinkedIn's 999, a sign-in wall): leave it alone for a while. */
  | { kind: 'throttled'; host: string; reason: string };

const LI = 'https://www.linkedin.com/jobs-guest/jobs/api';

/** The site an alert job's public posting is read from: Glassdoor and Indeed jobs are looked up on LinkedIn. */
export const publicHost = (id: string): string | null =>
  (id.startsWith('jobscz:') ? 'www.jobs.cz' : /^(linkedin|glassdoor|indeed):/.test(id) ? 'www.linkedin.com' : null);

/** Inner HTML of the first element whose opening tag matches `open`, balanced on that tag's name. */
export function innerOf(html: string, open: RegExp): string | null {
  const m = open.exec(html);
  const tag = m && /^<([a-z][a-z0-9]*)/i.exec(m[0])?.[1];
  if (!m || !tag) return null;
  const start = m.index + m[0].length;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 1;
  for (let t = re.exec(html); t; t = re.exec(html)) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return null;
}
const textOf = (html: string | null): string | null => {
  const t = html === null ? '' : decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return t || null;
};

/** LinkedIn's guest job view → the posting, with "Seniority level: …" and the like appended to the description. */
export function parseLinkedinPosting(html: string): (Omit<PublicPosting, 'url'> & { closed: boolean }) | null {
  const title = textOf(innerOf(html, /<h[12]\b[^>]*top-card-layout__title[^>]*>/i));
  const description = innerOf(html, /<div\b[^>]*show-more-less-html__markup[^>]*>/i);
  if (!title || !description) return null;
  const criteria: string[] = [];
  for (const item of html.split(/description__job-criteria-item/).slice(1)) {
    const k = textOf(innerOf(item, /<h3\b[^>]*description__job-criteria-subheader[^>]*>/i));
    const v = textOf(innerOf(item, /<span\b[^>]*description__job-criteria-text[^>]*>/i));
    if (k && v) criteria.push(`<li>${k}: ${v}</li>`);
  }
  return {
    title,
    company: textOf(innerOf(html, /<a\b[^>]*topcard__org-name-link[^>]*>/i)),
    location: textOf(innerOf(html, /<span class="topcard__flavor topcard__flavor--bullet"[^>]*>/i)),
    descriptionHtml: description + (criteria.length ? `<ul>${criteria.join('')}</ul>` : ''),
    closed: /closed-job|no longer accepting applications/i.test(html),
  };
}

/** LinkedIn's public job search → its job cards. */
export function parseLinkedinSearch(html: string): Array<{ id: string; title: string; company: string; location: string | null }> {
  const out: Array<{ id: string; title: string; company: string; location: string | null }> = [];
  for (const card of html.split(/(?=data-entity-urn="urn:li:jobPosting:)/).slice(1)) {
    const id = /^data-entity-urn="urn:li:jobPosting:(\d+)"/.exec(card)?.[1];
    const title = textOf(innerOf(card, /<h3\b[^>]*base-search-card__title[^>]*>/i));
    const company = textOf(innerOf(card, /<h4\b[^>]*base-search-card__subtitle[^>]*>/i));
    if (id && title && company) out.push({ id, title, company, location: textOf(innerOf(card, /<span\b[^>]*job-search-card__location[^>]*>/i)) });
  }
  return out;
}

/** A Jobs.cz detail page → the posting (schema.org when the page has it, else Jobs.cz's own layout). */
export function parseJobsCz(html: string): Omit<PublicPosting, 'url'> | null {
  const jp = extractJobPosting(html);
  if (jp && jp.descriptionHtml.trim()) return jp;
  const body = innerOf(html, /<div\b[^>]*data-jobad="body"[^>]*>/i);
  if (!body) return null;
  const og = decodeEntities(/<meta\s+property="og:title"\s+content="([^"]*)"/i.exec(html)?.[1] ?? '');
  const [ogTitle, ogCompany] = og.split(/\s+[–-]\s+/, 2);
  const title = textOf(innerOf(html, /<h1\b[^>]*>/i)) ?? (ogTitle?.trim() || null);
  if (!title) return null;
  const header = innerOf(html, /<div\b[^>]*data-test="jd-header-text"[^>]*>/i) ?? '';
  return {
    title,
    company: ogCompany?.trim() || null,
    location: textOf(innerOf(html, /<a\b[^>]*data-test="jd-info-location"[^>]*>/i)),
    descriptionHtml: header + body,
  };
}

/** robota.ua's vacancy JSON → the posting, with salary and its tags ("Вид занятости: …") appended to the description. */
export function parseRobota(json: string): (Omit<PublicPosting, 'url'> & { closed: boolean }) | null {
  let v: any;
  try { v = JSON.parse(json); } catch { return null; }
  const title = typeof v?.name === 'string' ? v.name.replace(/\s+/g, ' ').trim() : '';
  const description = typeof v?.description === 'string' ? innerOf(v.description, /<body\b[^>]*>/i) ?? v.description : '';
  if (!title || !description.trim()) return null;
  const facts: string[] = [];
  const pay = v.salaryFrom || v.salaryTo ? [v.salaryFrom, v.salaryTo].filter(Boolean).join('–') : v.salary || null;
  if (pay) facts.push(`<li>Salary: ${pay} UAH${v.salaryComment ? ` (${v.salaryComment})` : ''}</li>`);
  for (const c of Array.isArray(v.clusters) ? v.clusters : []) {
    const groups = (Array.isArray(c?.groups) ? c.groups : []).map((g: any) => g?.name).filter(Boolean);
    if (c?.name && groups.length) facts.push(`<li>${c.name}: ${groups.join(', ')}</li>`);
  }
  const remote = /Удаленная работа|Віддалена робота/.test(JSON.stringify(v.clusters ?? []));
  return {
    title,
    company: typeof v.companyName === 'string' && v.companyName.trim() ? v.companyName.trim() : null,
    location: [v.cityName, remote ? 'Remote' : null].filter(Boolean).join(', ') || null,
    descriptionHtml: description + (facts.length ? `<ul>${facts.join('')}</ul>` : ''),
    closed: v.isActive === false,
  };
}

/** HTTP refusals that mean "slow down", as opposed to "this job is gone". */
function pushback(e: unknown): PublicRead | null {
  if (!(e instanceof HttpError) || ![403, 429, 999].includes(e.status)) return null;
  const host = new URL(e.url).hostname;
  return { kind: 'throttled', host, reason: `${host} answered ${e.status}` };
}

export async function readLinkedinJob(id: string, http: HttpOptions): Promise<PublicRead> {
  let html: string;
  try {
    html = (await politeFetch(`${LI}/jobPosting/${id}`, http)).text;
  } catch (e) {
    const p = pushback(e);
    if (p) return p;
    if (e instanceof HttpError && [404, 410].includes(e.status)) return { kind: 'closed', reason: 'removed from LinkedIn' };
    throw e;
  }
  const p = parseLinkedinPosting(html);
  if (!p) return /authwall|sign in to view/i.test(html) ? { kind: 'throttled', host: 'www.linkedin.com', reason: 'LinkedIn asked to sign in' } : { kind: 'missing', reason: 'LinkedIn page has no posting text' };
  if (p.closed) return { kind: 'closed', reason: 'no longer accepting applications on LinkedIn' };
  return { kind: 'found', via: 'linkedin', posting: { url: `https://www.linkedin.com/jobs/view/${id}/`, title: p.title, company: p.company, location: p.location, descriptionHtml: p.descriptionHtml } };
}

/** The same job on LinkedIn's public search: same company, a title that matches (the ATS board rule). */
export async function findOnLinkedin(job: { title: string; company: string | null; location: string | null }, http: HttpOptions): Promise<PublicRead> {
  if (!job.company) return { kind: 'missing', reason: 'no company to look the job up by' };
  const q = new URLSearchParams({ keywords: `${job.title} ${job.company}` });
  if (job.location && !/remote|anywhere|віддален/i.test(job.location)) q.set('location', job.location);
  let html: string;
  try {
    html = (await politeFetch(`${LI}/seeMoreJobPostings/search?${q}`, http)).text;
  } catch (e) {
    const p = pushback(e);
    if (p) return p;
    if (e instanceof HttpError && e.status === 400) return { kind: 'missing', reason: 'not on LinkedIn' };
    throw e;
  }
  const cards = parseLinkedinSearch(html).filter((c) => sameCompany(c.company, job.company!));
  const hit = matchPosting(cards.map((c) => ({ source: 'linkedin', url: c.id, title: c.title })), job.title);
  if (!hit) return { kind: 'missing', reason: 'not found on LinkedIn' };
  return readLinkedinJob(hit.job.url, http);
}

export async function readJobsCz(url: string, http: HttpOptions): Promise<PublicRead> {
  let html: string;
  try {
    html = (await politeFetch(url, http)).text;
  } catch (e) {
    const p = pushback(e);
    if (p) return p;
    if (e instanceof HttpError && [404, 410].includes(e.status)) return { kind: 'closed', reason: 'removed from Jobs.cz' };
    throw e;
  }
  const p = parseJobsCz(html);
  if (!p) return { kind: 'missing', reason: 'Jobs.cz page has no posting text' };
  return { kind: 'found', via: 'jobscz', posting: { url, ...p } };
}

/** A robota.ua (or old rabota.ua) vacancy link, read through api.rabota.ua by its id. */
export async function readRobota(url: string, http: HttpOptions): Promise<PublicRead> {
  const c = canonicalize(url);
  if (!c?.key.startsWith('robota:')) return { kind: 'missing', reason: 'not a robota.ua vacancy link' };
  const id = c.key.slice('robota:'.length);
  let json: string;
  try {
    json = (await politeFetch(`https://api.rabota.ua/vacancy?id=${id}`, http)).text;
  } catch (e) {
    const p = pushback(e);
    if (p) return p;
    if (e instanceof HttpError && [404, 410].includes(e.status)) return { kind: 'closed', reason: 'removed from robota.ua' };
    throw e;
  }
  const p = parseRobota(json);
  if (!p) return { kind: 'missing', reason: 'robota.ua has no posting text' };
  if (p.closed) return { kind: 'closed', reason: 'no longer active on robota.ua' };
  return { kind: 'found', via: 'robota', posting: { url: c.url, title: p.title, company: p.company, location: p.location, descriptionHtml: p.descriptionHtml } };
}

/** An alert job by its key: LinkedIn and Jobs.cz are read directly; Glassdoor and Indeed are found on LinkedIn. */
export function readPublicPosting(job: { id: string; url: string; title: string; company: string | null; location: string | null }, http: HttpOptions): Promise<PublicRead> {
  const [site, id] = job.id.split(':', 2);
  if (site === 'linkedin') return readLinkedinJob(id, http);
  if (site === 'jobscz') return readJobsCz(job.url, http);
  if (site === 'glassdoor' || site === 'indeed') return findOnLinkedin(job, http);
  return Promise.resolve({ kind: 'missing', reason: 'no public page to read' });
}
