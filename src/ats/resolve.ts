import type { Store } from '../store/db.js';
import type { RawVacancy } from '../types.js';
import { HttpError, politeFetch, type HttpOptions } from '../util/http.js';
import { ATS_KINDS, type AtsKind, type BoardRef } from './boards.js';

const LEGAL = /\b(s\.?\s?r\.?\s?o|a\.?\s?s|gmbh|inc|ltd|llc|plc|b\.?\s?v|ag|oy|ab|sa|se|corp(oration)?|co|company|limited|holding|group)\b\.?/g;

/** Comparable company name: lowercase ASCII words, no legal suffixes ("Rohlik Group a.s." → "rohlik"). */
export function normCompany(name: string): string {
  const ascii = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ');
  const words = ascii.replace(/[^a-z0-9. ]+/g, ' ').replace(LEGAL, ' ').replace(/[.]/g, ' ').split(/\s+/).filter(Boolean);
  return words.join(' ');
}

/**
 * Board ids a company is likely to use: "Acme Cloud Labs" → acmecloudlabs, acme-cloud-labs, acme. The first word
 * alone only when it's distinctive (5+ letters): "Air Bank" must never try the board "air".
 */
export function slugCandidates(name: string): string[] {
  const words = normCompany(name).split(' ').filter(Boolean);
  if (!words.length) return [];
  const out = [words.join(''), words.join('-'), ...(words.length === 1 || words[0].length >= 5 ? [words[0]] : []), `${words.join('')}hq`];
  return [...new Set(out)].filter((s) => s.length >= 2).slice(0, 4);
}

/**
 * Same employer? Equal once legal suffixes go, or the shorter name (4+ letters) starts the longer one word for word
 * ("ITERA" / "ITERA Czech Republic, branch", "Cognite" / "Cognite - AI for Industry"). "Air" is not "Air Bank".
 */
export const sameCompany = (a: string, b: string): boolean => {
  const x = normCompany(a).split(' ').filter(Boolean);
  const y = normCompany(b).split(' ').filter(Boolean);
  if (!x.length || !y.length) return false;
  if (x.join('') === y.join('')) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.join('').length >= 4 && short.every((w, i) => long[i] === w);
};

/**
 * Does `board` exist on `ats` with open jobs, and (where the API names its owner) does it belong to `company`?
 * One request per probe. A 404 is a no, and so is an empty board: companies leave dead accounts behind on ATSs
 * they moved away from, and an empty one would stop the search before it reaches the board they use now.
 */
async function probe(ats: AtsKind, board: string, company: string, http: HttpOptions): Promise<boolean> {
  const get = async (url: string): Promise<any> => JSON.parse((await politeFetch(url, { ...http, retries: 1 })).text);
  const b = encodeURIComponent(board);
  try {
    switch (ats) {
      case 'greenhouse': {
        const d = await get(`https://boards-api.greenhouse.io/v1/boards/${b}`);
        if (!d?.name || !sameCompany(d.name, company)) return false;
        return ((await get(`https://boards-api.greenhouse.io/v1/boards/${b}/jobs`))?.jobs?.length ?? 0) > 0;
      }
      case 'lever': {
        for (const host of ['api.lever.co', 'api.eu.lever.co']) {
          try { const d = await get(`https://${host}/v0/postings/${b}?mode=json&limit=1`); if (Array.isArray(d) && d.length > 0) return true; } catch { /* try the EU host */ }
        }
        return false;
      }
      case 'ashby': { const d = await get(`https://api.ashbyhq.com/posting-api/job-board/${b}`); return (d?.jobs?.length ?? 0) > 0; }
      case 'workable': { const d = await get(`https://apply.workable.com/api/v1/widget/accounts/${b}`); return (d?.jobs?.length ?? 0) > 0 && sameCompany(d.name ?? '', company); }
      case 'recruitee': {
        const d = await get(`https://${b}.recruitee.com/api/offers/`);
        const owner = d?.offers?.[0]?.company_name;
        return (d?.offers?.length ?? 0) > 0 && (!owner || sameCompany(owner, company));
      }
      case 'smartrecruiters': {
        const d = await get(`https://api.smartrecruiters.com/v1/companies/${b}/postings?limit=1`);
        const owner = d?.content?.[0]?.company?.name;
        return (d?.totalFound ?? 0) > 0 && (!owner || sameCompany(owner, company));
      }
    }
  } catch (e) {
    if (e instanceof HttpError || e instanceof SyntaxError) return false;
    throw e;
  }
}

/**
 * The public job board a company uses, looked up across every supported ATS and remembered in the database —
 * including "none found", which is retried after `ttlDays`.
 */
export async function findBoard(company: string, store: Store, http: HttpOptions, ttlDays: number, now = new Date()): Promise<BoardRef | null> {
  const key = normCompany(company);
  if (!key) return null;
  const cached = store.boardGet(key);
  if (cached && (cached.ats || now.getTime() - Date.parse(cached.checked_at) < ttlDays * 86_400_000)) {
    return cached.ats ? { ats: cached.ats as AtsKind, board: cached.board! } : null;
  }
  // Every ATS is its own host, so one slug is probed on all of them at once; the first in ATS_KINDS order wins.
  for (const board of slugCandidates(company)) {
    const found = await Promise.all(ATS_KINDS.map((ats) => probe(ats, board, company, http)));
    const ats = ATS_KINDS[found.indexOf(true)];
    if (ats) {
      store.boardSet(key, { ats, board }, now);
      return { ats, board };
    }
  }
  store.boardSet(key, null, now);
  return null;
}

const SENIORITY = /\b(junior|middle|mid|senior|sr|jr|lead|staff|principal|ii|iii|iv|i)\b/g;
const tokens = (t: string): Set<string> =>
  new Set(t.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/full[\s-]?stack/g, 'fullstack')
    .replace(/front[\s-]?end/g, 'frontend').replace(/back[\s-]?end/g, 'backend').replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .replace(SENIORITY, ' ').split(/\s+/).filter((w) => w.length > 1 && !['and', 'the', 'for', 'with', 'm/f/d', 'f/m/d'].includes(w)));

/** How alike two job titles are, 0–1, ignoring seniority words and spelling variants. */
export function titleSimilarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / new Set([...x, ...y]).size;
}

/** The posting on a board that an alert's title refers to, if one is close enough to be the same job. */
export function matchPosting(jobs: RawVacancy[], title: string, min = 0.6): { job: RawVacancy; score: number } | null {
  let best: { job: RawVacancy; score: number } | null = null;
  for (const job of jobs) {
    const score = titleSimilarity(job.title, title);
    if (score >= min && (!best || score > best.score)) best = { job, score };
  }
  return best;
}
