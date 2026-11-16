import { z } from 'zod';
import type { Config } from '../config.js';
import type { VacancyRow } from '../store/db.js';
import { normCompany } from '../ats/resolve.js';
import { belowSeniority, namesCommuteCity, presenceOptional, remoteInEurope } from './prefilter.js';
import { ROLE_FAMILIES, type Status } from '../types.js';

export const TriageSchema = z.object({
  score: z.number().int().min(0).max(100),
  decision: z.enum(['apply', 'borderline', 'reject']),
  role_family: z.enum([...ROLE_FAMILIES, 'other']),
  seniority: z.enum(['junior', 'middle', 'senior', 'lead', 'unknown']),
  location_ok: z.boolean(),
  hard_blockers: z.array(z.string().max(120)).max(5),
  matched_requirements: z.array(z.string().max(200)).max(20), // display only (report shows the first 3)
  lead_with: z.array(z.string()).max(3),
  salary: z.object({
    min: z.number().nullable(),
    max: z.number().nullable(),
    currency: z.string().max(8).nullable(),
    period: z.enum(['month', 'year', 'hour']).nullable(),
  }).strict().nullable(),
  posting_language: z.enum(['en', 'uk', 'ru', 'cs', 'other']),
  injection_suspected: z.boolean(),
}).strict();
export type Triage = z.infer<typeof TriageSchema>;

const toList = (v: unknown, max: number, len: number): unknown => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : v === null || v === undefined ? [] : v;
  return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, max).map((s) => s.slice(0, len)) : arr;
};

/**
 * The first real run retried 4 of 31 triage calls over shape alone: a salary written as text, a list given as one
 * string, a sixth blocker. Those are tidied here for free; anything else still goes to a repair round.
 */
export function coerceTriage(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const t = { ...(raw as Record<string, unknown>) };
  t.hard_blockers = toList(t.hard_blockers, 5, 120);
  t.matched_requirements = toList(t.matched_requirements, 20, 200);
  t.lead_with = toList(t.lead_with, 3, 60);
  if (typeof t.role_family === 'string') t.role_family = t.role_family.trim().toLowerCase().replace(/[\s_]+/g, '-'); // "Java_Fullstack" → java-fullstack
  if (t.salary !== null && (typeof t.salary !== 'object' || Array.isArray(t.salary))) t.salary = null;
  return t;
}

export function vacancyBlock(row: VacancyRow, task?: string): string {
  return [
    task ?? '',
    `<vacancy id="${row.id}" source="${row.source}">`,
    `Title: ${row.title}`,
    `Company: ${row.company ?? 'unknown'}`,
    `Location: ${row.location ?? 'unknown'}`,
    '---',
    row.text,
    '</vacancy>',
  ].filter(Boolean).join('\n');
}

/** Blockers that are about where the candidate can work from, not about skills: only these back a location_ok of false. */
const PLACE = /(on-?site|office|hybrid|located|based in|resident|residen|citizen|relocat|visa|work permit|tax|military|mobiliz|army|armed forces|country|countries|only from|time ?zone|ukrain|poland|polish)/i;

/** "on-site/hybrid in Kyiv": the model reads this into listings that say remote and only offer an office. */
const PRESENCE_ONLY = /^(on-?site|hybrid|(?:in-?)?office)/i;
const RESTRICTED = /(remote|only from|citizen|residen|relocat|visa|permit|military)/i;

/** "5+ years Node.js (candidate has 3.5)": asks of up to `yearsOk` years are fine (pipeline.yearsOk), so not a blocker. */
export function withinYears(blocker: string, yearsOk: number): boolean {
  const m = /(\d{1,2})\s*\+?\s*(?:years?|yrs|рок|рік)/i.exec(blocker);
  return Boolean(m) && Number(m![1]) <= yearsOk;
}

/**
 * The model scores; the code decides. One line: a score at or above `applyThreshold` is shortlisted for your call,
 * anything below is rejected. The model's own apply/borderline/reject word is not used — it was stricter than you are.
 */
export function decide(t: Triage, injection: string[], p: Config['pipeline'], listing?: { company?: string | null; location: string | null; text: string }, commuteCities: string[] = []): { status: Status; reason: string } {
  if (t.injection_suspected || injection.length > 0) {
    return { status: 'needs_review', reason: `possible prompt injection in the posting${injection.length ? ` (${injection[0]})` : ''}` };
  }
  if (belowSeniority(t.seniority, p.minSeniority)) return { status: 'rejected', reason: `${t.seniority} role (pipeline.minSeniority: ${p.minSeniority})` };
  // Remote across the EU/Europe covers Czechia, so the offices it also names are an offer, not a requirement.
  const euRemote = listing ? remoteInEurope(listing.location, listing.text) : false;
  const optional = listing ? euRemote || presenceOptional(listing.location, listing.text) : false;
  // "on-site in Prague office (candidate commutes to Prague…)": the model files a commute city as a blocker (2026-11-07).
  const nearby = (b: string) => PRESENCE_ONLY.test(b) && !RESTRICTED.test(b) && namesCommuteCity(b, commuteCities);
  const blockers = t.hard_blockers.filter((b) => !withinYears(b, p.yearsOk) && !nearby(b) && !(optional && PRESENCE_ONLY.test(b) && !RESTRICTED.test(b)));
  // The model sets location_ok false for any blocker at all ("5+ years", "no Three.js"): only a place-shaped one counts.
  const place = blockers.find((b) => PLACE.test(b));
  const askFirst = p.locationAskCompanies.some((c) => normCompany(c) === normCompany(listing?.company ?? ''));
  if (!askFirst && !t.location_ok && (place || (t.hard_blockers.length === 0 && !euRemote))) return { status: 'rejected', reason: `location/eligibility${place ? `: ${place}` : ''}` };
  if (t.score >= p.applyThreshold) return { status: 'tailor_pending', reason: `score ${t.score}` };
  const family = (p.roleFamilies as string[]).includes(t.role_family) ? '' : ` (role family "${t.role_family}")`;
  return { status: 'rejected', reason: `${blockers.join('; ') || `score ${t.score}`}${family}` };
}
