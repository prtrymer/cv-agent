import type { RawVacancy } from '../types.js';
import { politeFetch, type HttpOptions } from '../util/http.js';

/** Applicant-tracking systems with a public, documented job-board API — no scraping, no login. */
export const ATS_KINDS = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters'] as const;
export type AtsKind = (typeof ATS_KINDS)[number];
export interface BoardRef { ats: AtsKind; board: string }
export interface BoardFilter {
  /** Title prefilter, applied before descriptions are fetched or stored. */
  keep: (title: string) => boolean;
  /** Canonical-URL check for jobs already in the database; SmartRecruiters skips their detail requests. */
  known?: (url: string) => boolean;
}
export interface Board { ref: BoardRef; company: string | null; jobs: RawVacancy[]; total: number }

const MAX_BYTES = 30_000_000;
const MAX_DETAILS = 30;
const enc = encodeURIComponent;

async function getJson(url: string, http: HttpOptions): Promise<any> {
  const res = await politeFetch(url, { ...http, maxBytes: Math.max(http.maxBytes, MAX_BYTES) });
  try { return JSON.parse(res.text); } catch { throw new Error(`not JSON from ${url}`); }
}

const decodeEntities = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const joinLoc = (...parts: Array<string | null | undefined | false>): string | null => parts.filter(Boolean).join(', ') || null;
const mode = (remote: boolean | undefined, workplace?: string | null): string =>
  remote ? ' (remote)' : workplace && !/unspecified/i.test(workplace) ? ` (${workplace.toLowerCase()})` : '';

/** Every open job on one company board whose title passes the filter, with its full description for triage. */
export async function fetchBoard(ref: BoardRef, http: HttpOptions, f: BoardFilter): Promise<Board> {
  const b = ref.board;
  const source = `ats-${ref.ats}`;
  switch (ref.ats) {
    case 'greenhouse': {
      const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${enc(b)}/jobs?content=true`, http);
      const all: any[] = d.jobs ?? [];
      const jobs = all.filter((j) => f.keep(String(j.title ?? ''))).map((j): RawVacancy => ({
        source, url: `https://job-boards.greenhouse.io/${b}/jobs/${j.id}`, title: j.title, company: j.company_name ?? null,
        location: j.location?.name ?? null, descriptionHtml: decodeEntities(String(j.content ?? '')), postedAt: j.first_published ?? j.updated_at ?? null,
      }));
      return { ref, company: all[0]?.company_name ?? null, jobs, total: all.length };
    }
    case 'lever': {
      let all: any[];
      try { all = await getJson(`https://api.lever.co/v0/postings/${enc(b)}?mode=json`, http); }
      catch { all = await getJson(`https://api.eu.lever.co/v0/postings/${enc(b)}?mode=json`, http); }
      if (!Array.isArray(all)) throw new Error(`lever board "${b}" not found`);
      const jobs = all.filter((j) => f.keep(String(j.text ?? ''))).map((j): RawVacancy => ({
        source, url: j.hostedUrl, title: j.text, company: null,
        location: `${j.categories?.allLocations?.join(' / ') ?? j.categories?.location ?? ''}${mode(false, j.workplaceType)}`.trim() || null,
        descriptionHtml: [j.description ?? '', ...(j.lists ?? []).map((l: any) => `<h3>${l.text}</h3><ul>${l.content}</ul>`), j.additional ?? ''].join('\n'),
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      }));
      return { ref, company: null, jobs, total: all.length };
    }
    case 'ashby': {
      const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${enc(b)}`, http);
      const all: any[] = (d.jobs ?? []).filter((j: any) => j.isListed !== false);
      const jobs = all.filter((j) => f.keep(String(j.title ?? ''))).map((j): RawVacancy => ({
        source, url: j.jobUrl, title: j.title, company: null,
        location: `${joinLoc(j.location, ...(j.secondaryLocations ?? []).map((l: any) => l.location)) ?? ''}${mode(j.isRemote, j.workplaceType)}`.trim() || null,
        descriptionHtml: j.descriptionHtml ?? '', postedAt: j.publishedAt ?? null,
      }));
      return { ref, company: null, jobs, total: all.length };
    }
    case 'workable': {
      const d = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${enc(b)}?details=true`, http);
      const all: any[] = d.jobs ?? [];
      const jobs = all.filter((j) => f.keep(String(j.title ?? ''))).map((j): RawVacancy => ({
        source, url: `https://apply.workable.com/${b}/j/${j.shortcode}/`, title: j.title, company: d.name ?? null,
        location: `${joinLoc(j.city, j.country) ?? ''}${mode(j.telecommuting)}`.trim() || null,
        descriptionHtml: j.description ?? '', postedAt: j.published_on ?? null,
      }));
      return { ref, company: d.name ?? null, jobs, total: all.length };
    }
    case 'recruitee': {
      const d = await getJson(`https://${enc(b)}.recruitee.com/api/offers/`, http);
      const all: any[] = d.offers ?? [];
      const jobs = all.filter((j) => f.keep(String(j.title ?? ''))).map((j): RawVacancy => ({
        source, url: `https://${b}.recruitee.com/o/${j.slug}`, title: j.title, company: j.company_name ?? null,
        location: `${j.location ?? ''}${mode(j.remote, j.hybrid ? 'hybrid' : j.on_site ? 'on-site' : null)}`.trim() || null,
        descriptionHtml: `${j.description ?? ''}\n${j.requirements ?? ''}`, postedAt: j.published_at ?? null,
      }));
      return { ref, company: all[0]?.company_name ?? null, jobs, total: all.length };
    }
    case 'smartrecruiters': {
      const base = `https://api.smartrecruiters.com/v1/companies/${enc(b)}/postings`;
      const all: any[] = [];
      for (let offset = 0; offset < 1000; offset += 100) {
        const page = await getJson(`${base}?limit=100&offset=${offset}`, http);
        all.push(...(page.content ?? []));
        if (all.length >= (page.totalFound ?? 0) || !(page.content ?? []).length) break;
      }
      const wanted = all.filter((j) => f.keep(String(j.name ?? '')));
      const jobs: RawVacancy[] = [];
      for (const j of wanted) {
        const url = `https://jobs.smartrecruiters.com/${b}/${j.id}`;
        if (f.known?.(url) || jobs.length >= MAX_DETAILS) continue;
        const d = await getJson(`${base}/${enc(j.id)}`, http);
        const s = d.jobAd?.sections ?? {};
        jobs.push({
          source, url, title: j.name, company: j.company?.name ?? null,
          location: `${joinLoc(j.location?.city, j.location?.country?.toUpperCase()) ?? ''}${mode(j.location?.remote)}`.trim() || null,
          descriptionHtml: ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'].map((k) => s[k]?.text ?? '').join('\n'),
          postedAt: j.releasedDate ?? null,
        });
      }
      return { ref, company: all[0]?.company?.name ?? null, jobs, total: all.length };
    }
  }
}
