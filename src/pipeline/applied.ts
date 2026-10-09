import { normCompany, sameCompany } from '../ats/resolve.js';
import type { Ctx } from '../ctx.js';
import { extractJobPosting } from '../sources/manual.js';
import { politeFetch } from '../util/http.js';
import { canonicalize } from '../util/url.js';

export interface AppliedCompany { name: string; link: string }

/** Company named by the link itself: DOU's /companies/<slug>/, an ATS board id. */
export function companyFromLink(link: string): string | null {
  const dou = /jobs\.dou\.ua\/companies\/([^/]+)\//.exec(link)?.[1];
  if (dou) return dou.replace(/-/g, ' ');
  const key = canonicalize(link)?.key ?? '';
  const board = /^(greenhouse|recruitee):([^:]+):/.exec(key)?.[2]
    ?? /(?:jobs\.(?:eu\.)?lever\.co|jobs\.ashbyhq\.com|apply\.workable\.com|jobs\.smartrecruiters\.com)\/([^/]+)\//.exec(link)?.[1];
  return board && board !== 'j' ? board.replace(/[-_]/g, ' ') : null;
}

/**
 * Every company you have already applied to: written after the link (`# Company`) or named in it, looked up once (and remembered) for
 * links that don't name one — Djinni and other job pages, never LinkedIn/Glassdoor — and every vacancy marked applied.
 */
export async function appliedCompanies(ctx: Ctx, entries: Array<{ url: string; company: string | null }>): Promise<AppliedCompany[]> {
  const out: AppliedCompany[] = [];
  for (const { url: link, company } of entries) {
    const named = company ?? companyFromLink(link);
    if (named) { out.push({ name: named, link }); continue; }
    let cached = ctx.store.appliedCompanyGet(link);
    if (cached === undefined) {
      cached = null;
      if (!/(^|\.)(linkedin|glassdoor)\./i.test(new URL(link).hostname)) {
        try { cached = extractJobPosting((await politeFetch(link, ctx.cfg.http)).text)?.company ?? null; } catch { /* gone or blocked: remembered as unknown */ }
      }
      ctx.store.appliedCompanySet(link, cached);
    }
    if (cached) out.push({ name: cached, link });
  }
  for (const row of ctx.store.byStatus(['applied'])) if (row.company) out.push({ name: row.company, link: row.url });
  return out;
}

/** The earlier application at the same employer, if any. */
export function sameCompanyAs(list: AppliedCompany[], v: { company: string | null; url: string }): AppliedCompany | null {
  const names = [v.company, companyFromLink(v.url)].filter((n): n is string => Boolean(n && normCompany(n)));
  if (!names.length) return null;
  return list.find((a) => a.link !== v.url && names.some((n) => sameCompany(n, a.name) || normCompany(n).replace(/\s/g, '') === normCompany(a.name).replace(/\s/g, ''))) ?? null;
}
