import { normCompany, sameCompany } from '../ats/resolve.js';
import type { Ctx } from '../ctx.js';
import { extractJobPosting } from '../sources/manual.js';
import { politeFetch } from '../util/http.js';
import { canonicalize } from '../util/url.js';

export interface AppliedCompany {
  name: string; link: string;
  /** The role, when known (the vacancy row, or a Djinni link's slug): a repost is the same role posted again. */
  title?: string | null;
  /** When you applied, as near as is known (ISO). */
  at?: string | null;
}
export interface AppliedEntry { url: string; company: string | null; on?: string | null }

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
 * When you applied through a tracking-sheet link: the date written after it (`# Company 2026-09-22`), else when it was
 * marked applied here, else the first run that saw the line (so a line added today counts as an application today).
 */
export function appliedOn(ctx: Ctx, e: AppliedEntry): string {
  if (e.on) return new Date(`${e.on}T12:00:00Z`).toISOString();
  const key = canonicalize(e.url)?.key;
  return (key && ctx.store.appliedEventAt(key)) || ctx.store.appliedSeen(e.url, ctx.now());
}

/** Every tracking-sheet link and vacancy marked applied, by canonical key, with the date you applied. */
export function appliedDates(ctx: Ctx, entries: AppliedEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    const key = canonicalize(e.url)?.key;
    if (key) out.set(key, appliedOn(ctx, e));
  }
  for (const row of ctx.store.byStatus(['applied'], 100_000)) if (!out.has(row.id)) out.set(row.id, ctx.store.appliedEventAt(row.id) ?? row.updated_at);
  return out;
}

/** Djinni's link carries the title: /jobs/900230-ai-engineer/ → "ai engineer". */
const titleFromLink = (link: string): string | null => /djinni\.co\/jobs\/\d+-([^/?#]+)/.exec(link)?.[1].replace(/-/g, ' ') ?? null;

/**
 * Every company you have already applied to: written after the link (`# Company`) or named in it, looked up once (and remembered) for
 * links that don't name one — Djinni and other job pages, never LinkedIn/Glassdoor — and every vacancy marked applied.
 */
export async function appliedCompanies(ctx: Ctx, entries: AppliedEntry[]): Promise<AppliedCompany[]> {
  const out: AppliedCompany[] = [];
  const about = (link: string): Pick<AppliedCompany, 'title'> => {
    const key = canonicalize(link)?.key;
    return { title: (key && ctx.store.get(key)?.title) || titleFromLink(link) };
  };
  for (const e of entries) {
    const link = e.url;
    const named = e.company ?? companyFromLink(link);
    if (named) { out.push({ name: named, link, ...about(link), at: appliedOn(ctx, e) }); continue; }
    let cached = ctx.store.appliedCompanyGet(link);
    if (cached === undefined) {
      cached = null;
      if (!/(^|\.)(linkedin|glassdoor)\./i.test(new URL(link).hostname)) {
        try { cached = extractJobPosting((await politeFetch(link, ctx.cfg.http)).text)?.company ?? null; } catch { /* gone or blocked: remembered as unknown */ }
      }
      ctx.store.appliedCompanySet(link, cached);
    }
    if (cached) out.push({ name: cached, link, ...about(link), at: appliedOn(ctx, e) });
  }
  for (const row of ctx.store.byStatus(['applied'], 100_000)) {
    if (row.company) out.push({ name: row.company, link: row.url, title: row.title, at: ctx.store.appliedEventAt(row.id) ?? row.updated_at });
  }
  return out;
}

/** Every earlier application at the same employer. */
export function sameCompanyAll(list: AppliedCompany[], v: { company: string | null; url: string }, separate: string[][] = []): AppliedCompany[] {
  const names = [v.company, companyFromLink(v.url)].filter((n): n is string => Boolean(n && normCompany(n)));
  if (!names.length) return [];
  const apart = (a: string, b: string): boolean => normCompany(a) !== normCompany(b)
    && separate.some((group) => [a, b].every((name) => group.some((g) => normCompany(g) === normCompany(name))));
  return list.filter((a) => a.link !== v.url && names.some((n) => !apart(n, a.name) && (sameCompany(n, a.name) || normCompany(n).replace(/\s/g, '') === normCompany(a.name).replace(/\s/g, ''))));
}

/** The earlier application at the same employer, if any. */
export function sameCompanyAs(list: AppliedCompany[], v: { company: string | null; url: string }, separate: string[][] = []): AppliedCompany | null {
  return sameCompanyAll(list, v, separate)[0] ?? null;
}

/** Words that don't make a role different: seniority, work mode, the "(m/f/d)" and "(AI Native)" asides. */
const FILLER = new Set(['junior', 'jr', 'middle', 'mid', 'senior', 'sr', 'regular', 'strong', 'remote', 'hybrid', 'office', 'onsite', 'and', 'with', 'for', 'the']);

/** "Middle Full-Stack Developer (AI Native)" and "Full Stack Engineer" are the same role; "Java Developer" is not. */
export function sameRole(a: string, b: string): boolean {
  const words = (t: string): string => [...new Set(t.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(full|front|back)[\s-]+(stack|end)\b/g, '$1$2').replace(/\bnode[\s.]?js\b/g, 'nodejs').replace(/\bengineer\b/g, 'developer')
    .split(/[^\p{L}\p{N}+#]+/u).filter((w) => w.length > 1 && !FILLER.has(w)))].sort().join(' ');
  const x = words(a);
  return Boolean(x) && x === words(b);
}

const DAY = 86_400_000;
const daysBetween = (from: string, to: Date): number => Math.floor((to.getTime() - Date.parse(from)) / DAY);

export interface EarlierCheck {
  /** Set it aside: you applied to this employer (and it is no repost). */
  earlier: AppliedCompany | null;
  /** Screen it again: the same role, applied to at least `days` ago, with no application at this employer since. */
  repost: { link: string; at: string } | null;
}

/**
 * What an earlier application means for this vacancy. `own` is when you applied through this very link (a repost of it
 * moves its date on). A different role at the same employer is still set aside, however long ago; `days: null` = no reposts.
 */
export function earlierApplication(list: AppliedCompany[], v: { company: string | null; url: string; title: string }, o: { separate?: string[][]; days: number | null; now: Date; own?: string | null }): EarlierCheck {
  const all = sameCompanyAll(list, v, o.separate);
  const old = (at: string | null | undefined): boolean => Boolean(at) && o.days !== null && daysBetween(at!, o.now) >= o.days;
  if (o.days !== null && all.every((a) => old(a.at)) && (!o.own || old(o.own))) {
    const same = o.own ? { link: v.url, at: o.own } : all.find((a) => a.title && sameRole(a.title, v.title));
    if (same) return { earlier: null, repost: { link: same.link, at: same.at! } };
  }
  return { earlier: all[0] ?? null, repost: null };
}

/** "reposted: you applied on 2026-09-25 (46 days ago)". */
export function repostNote(at: string, now: Date, link?: string): string {
  return `reposted: you applied on ${at.slice(0, 10)} (${daysBetween(at, now)} days ago)${link ? ` — ${link}` : ''}`;
}
