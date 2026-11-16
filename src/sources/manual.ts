import type { Config } from '../config.js';
import type { RawVacancy } from '../types.js';
import { politeFetch } from '../util/http.js';
import { decodeEntities } from '../util/text.js';
import { canonicalize } from '../util/url.js';
import { innerOf, readJobsCz, readLinkedinJob, readRobota, type PublicRead } from './public.js';

/** schema.org JobPosting is on most company career pages and every big applicant-tracking system. */
export function extractJobPosting(html: string): { title: string; company: string | null; location: string | null; descriptionHtml: string } | null {
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const job = findJobPosting(data);
    if (job) {
      return {
        title: String(job.title ?? '').trim() || 'Untitled role',
        company: str(job.hiringOrganization?.name) ?? null,
        location: jobLocation(job),
        descriptionHtml: String(job.description ?? ''),
      };
    }
  }
  return null;
}

function findJobPosting(node: any): any | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const n of node) { const f = findJobPosting(n); if (f) return f; } return null; }
  const t = node['@type'];
  if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return node;
  if (node['@graph']) return findJobPosting(node['@graph']);
  return null;
}
/** The same JobPosting as microdata (itemprop attributes): SAP SuccessFactors career sites (*.jobs2web.com) have no JSON-LD. */
export function extractMicrodataPosting(html: string): { title: string; company: string | null; location: string | null; descriptionHtml: string } | null {
  if (!/itemtype=["']https?:\/\/schema\.org\/JobPosting["']/i.test(html)) return null;
  const text = (name: string): string | null => {
    const v = itemprop(html, name);
    return v === null ? null : str(decodeEntities(v.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '));
  };
  const place = [text('addressLocality'), text('addressCountry')].filter(Boolean).join(', ');
  return {
    title: text('title') ?? 'Untitled role',
    company: text('hiringOrganization'),
    location: place || text('streetAddress'),
    descriptionHtml: itemprop(html, 'description') ?? html,
  };
}

/** A microdata property's value: a `content` attribute, else the element's inner HTML up to its matching close tag. */
function itemprop(html: string, name: string): string | null {
  const open = new RegExp(`<\\w+\\b[^>]*\\bitemprop=["']${name}["'][^>]*>`, 'i');
  const tag = open.exec(html)?.[0];
  if (!tag) return null;
  const content = /\bcontent=["']([^"']*)["']/i.exec(tag);
  if (content) return content[1];
  return /^<meta\b/i.test(tag) || tag.endsWith('/>') ? null : innerOf(html, open);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
function jobLocation(job: any): string | null {
  if (String(job.jobLocationType ?? '').toUpperCase() === 'TELECOMMUTE') return 'Remote';
  const loc = Array.isArray(job.jobLocation) ? job.jobLocation[0] : job.jobLocation;
  const a = loc?.address ?? loc;
  return [str(a?.addressLocality), str(a?.addressCountry) ?? str(a?.addressCountry?.name)].filter(Boolean).join(', ') || null;
}

/**
 * `add <url>`: one vacancy from anywhere. LinkedIn and Jobs.cz postings are read from their public (logged-out) page
 * when alerts.publicPages is on; robota.ua through its JSON API (its pages are behind Cloudflare). Glassdoor and Indeed
 * pages are never fetched — paste the text instead.
 */
export async function manualVacancy(url: string, pasted: string | null, cfg: Config): Promise<RawVacancy> {
  const host = new URL(url).hostname.toLowerCase();
  if (pasted) {
    const first = pasted.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Untitled role';
    return { source: 'manual', url, title: first.slice(0, 160), descriptionText: pasted };
  }
  const key = canonicalize(url)?.key ?? '';
  const paste = 'save the posting text and pass it with --file (or paste it on the dashboard)';
  if (/^(linkedin|jobscz):/.test(key) && cfg.alerts.publicPages.enabled) {
    const http = { ...cfg.http, minIntervalMsPerHost: Math.max(cfg.http.minIntervalMsPerHost, cfg.alerts.publicPages.minIntervalMs), retries: 1 };
    const r: PublicRead = key.startsWith('linkedin:') ? await readLinkedinJob(key.slice('linkedin:'.length), http) : await readJobsCz(canonicalize(url)!.url, http);
    if (r.kind === 'found') return { source: 'manual', url: r.posting.url, title: r.posting.title, company: r.posting.company, location: r.posting.location, descriptionHtml: r.posting.descriptionHtml };
    throw new Error(r.kind === 'closed' ? `this posting is closed (${r.reason})` : `couldn't read the public posting (${r.reason}) — ${paste}`);
  }
  if (key.startsWith('robota:')) {
    const r = await readRobota(url, { ...cfg.http, retries: 1 });
    if (r.kind === 'found') return { source: 'manual', url: r.posting.url, title: r.posting.title, company: r.posting.company, location: r.posting.location, descriptionHtml: r.posting.descriptionHtml };
    throw new Error(r.kind === 'closed' ? `this posting is closed (${r.reason})` : `couldn't read the robota.ua posting (${r.reason}) — ${paste}`);
  }
  if (/^(linkedin|glassdoor|indeed):/.test(key)) throw new Error(`${host} pages aren't fetched — ${paste}`);
  if (key.startsWith('greenhouse:')) {
    // A company with its own careers site redirects this link to a page that loads the job in an iframe: only the API has the text.
    const [, board, id] = key.split(':');
    try {
      const j = JSON.parse((await politeFetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?content=true`, cfg.http)).text);
      if (j.title) return { source: 'manual', url, title: String(j.title).trim(), company: j.company_name ?? null, location: j.location?.name ?? null, descriptionHtml: decodeEntities(String(j.content ?? '')), postedAt: j.first_published ?? j.updated_at ?? null };
    } catch { /* not on the API: the page itself may still carry it */ }
  }
  const workable = /^apply\.workable\.com$/.test(host) ? /^\/([^/]+)\/j\/([a-z0-9]+)/i.exec(new URL(url).pathname) : null;
  if (workable) {
    // Workable job pages are an empty shell filled in by script (2026-11-13: screened on 0 characters): the API has the text.
    const [, account, code] = workable;
    try {
      const j = JSON.parse((await politeFetch(`https://apply.workable.com/api/v2/accounts/${encodeURIComponent(account)}/jobs/${code}`, cfg.http)).text);
      if (j.title) {
        let company: string | null = null;
        try { company = str(JSON.parse((await politeFetch(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}`, cfg.http)).text).name); } catch { /* the name is a nicety */ }
        // Every place it is offered in, not just the first: "Madrid; Lisbon; Prague" is a Prague job too.
        const places = (Array.isArray(j.locations) && j.locations.length ? j.locations : [j.location])
          .map((l: any) => [str(l?.city), str(l?.country)].filter(Boolean).join(', ')).filter(Boolean);
        const where = `${[...new Set(places)].join('; ')}${j.remote || j.workplace === 'remote' ? ' (remote)' : j.workplace === 'hybrid' ? ' (hybrid)' : ''}`.trim();
        const section = (name: string, html: unknown) => (str(html) ? `<h2>${name}</h2>${html}` : '');
        return {
          source: 'manual', url, title: String(j.title).trim(), company, location: where || null,
          descriptionHtml: `${j.description ?? ''}${section('Requirements', j.requirements)}${section('Benefits', j.benefits)}`, postedAt: j.published ?? null,
        };
      }
    } catch { /* not on the API: the page itself may still carry it */ }
  }
  const res = await politeFetch(url, cfg.http);
  // "…/openings/?gh_jid=123": a careers page with Greenhouse embedded, which names its board in the embed script.
  const job = new URL(url).searchParams.get('gh_jid');
  const board = /job_board\/js\?for=([\w-]+)/.exec(res.text)?.[1];
  if (job && board) return manualVacancy(`https://job-boards.greenhouse.io/${board}/jobs/${job}`, null, cfg);
  const jp = extractJobPosting(res.text) ?? extractMicrodataPosting(res.text);
  if (jp) return { source: 'manual', url, title: jp.title, company: jp.company, location: jp.location, descriptionHtml: jp.descriptionHtml };
  // og:title is usually the bare job title; <title> carries the site's suffix ("… Job Details | Acme")
  const og = str(decodeEntities(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i.exec(res.text)?.[1] ?? ''));
  const title = og ?? /<title[^>]*>([^<]*)<\/title>/i.exec(res.text)?.[1]?.trim() ?? url;
  return { source: 'manual', url, title, descriptionHtml: res.text };
}
