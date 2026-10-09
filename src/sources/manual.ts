import type { Config } from '../config.js';
import type { RawVacancy } from '../types.js';
import { politeFetch } from '../util/http.js';

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
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
function jobLocation(job: any): string | null {
  if (String(job.jobLocationType ?? '').toUpperCase() === 'TELECOMMUTE') return 'Remote';
  const loc = Array.isArray(job.jobLocation) ? job.jobLocation[0] : job.jobLocation;
  const a = loc?.address ?? loc;
  return [str(a?.addressLocality), str(a?.addressCountry) ?? str(a?.addressCountry?.name)].filter(Boolean).join(', ') || null;
}

/** `add <url>`: one vacancy from anywhere. LinkedIn and Glassdoor pages are never fetched — paste the text instead. */
export async function manualVacancy(url: string, pasted: string | null, cfg: Config): Promise<RawVacancy> {
  const host = new URL(url).hostname.toLowerCase();
  if (pasted) {
    const first = pasted.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Untitled role';
    return { source: 'manual', url, title: first.slice(0, 160), descriptionText: pasted };
  }
  if (/(^|\.)linkedin\.com$/.test(host) || /(^|\.)glassdoor\./.test(host)) {
    throw new Error('LinkedIn and Glassdoor pages are never fetched — save the posting text and pass it with --file');
  }
  const res = await politeFetch(url, cfg.http);
  const jp = extractJobPosting(res.text);
  if (jp) return { source: 'manual', url, title: jp.title, company: jp.company, location: jp.location, descriptionHtml: jp.descriptionHtml };
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(res.text)?.[1]?.trim() ?? url;
  return { source: 'manual', url, title, descriptionHtml: res.text };
}
