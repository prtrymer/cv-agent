import type { Config } from '../config.js';

export type PrefilterResult = { pass: true } | { pass: false; reason: string };
export interface LocationPrefs { commuteCities: string[]; remote: boolean }

const CITY_ALIASES: Record<string, string[]> = {
  olomouc: ['olomouc', 'оломоуц'],
  prague: ['prague', 'praha', 'прага', 'praze'],
  brno: ['brno', 'брно', 'brně'],
};
const REMOTE = /(remote|віддален|дистанц|удален|home[- ]office|work from home|anywhere)/i;
const NO_REMOTE = /(no remote|not remote|without remote|on-?site only|office only|лише офіс|тільки офіс|без віддален)/i;
const ONSITE = /(on-?site|in[- ]office|office in|our office|офіс|hybrid|гібрид|relocation required)/i;

/** Deterministic and free: everything dropped here never reaches the model. */
export function prefilter(v: { title: string; location: string | null; text: string }, cfg: Config['prefilter'], loc: LocationPrefs): PrefilterResult {
  const byTitle = titleCheck(v.title, cfg);
  if (!byTitle.pass) return byTitle;

  const years = requiredYears(v.text);
  if (years !== null && years > cfg.maxYearsRequired) return { pass: false, reason: `asks for ${years}+ years` };

  return locationCheck(`${v.location ?? ''}\n${v.text.slice(0, 2500)}`, loc);
}

const ENTRY = /(?<![\p{L}])(trainee|intern|internship|apprentice|graduate|entry[- ]level|стажер|стажист|стажування|практикант)(?![\p{L}])/iu;
const JUNIOR = /(?<![\p{L}])(junior|jr\.?|джуніор|молодший)(?![\p{L}])/iu;
const MIDDLE_UP = /(?<![\p{L}])(middle|mid|senior|strong|lead|сеньйор|мідл)(?![\p{L}])/iu;
/** Trainee/intern roles, and junior roles that don't also say middle ("Junior+/Middle" is fine). */
export const belowMiddle = (title: string): boolean => ENTRY.test(title) || (JUNIOR.test(title) && !MIDDLE_UP.test(title));

/** The title rules alone — also used by job-board sources to skip irrelevant jobs before fetching their details. */
export function titleCheck(title: string, cfg: Config['prefilter']): PrefilterResult {
  const include = cfg.titleInclude.map((s) => new RegExp(s, 'i'));
  const exclude = cfg.titleExclude.map((s) => new RegExp(s, 'i'));
  if (include.length > 0 && !include.some((r) => r.test(title))) return { pass: false, reason: 'title: not a matching role' };
  const hit = exclude.find((r) => r.test(title));
  if (hit) return { pass: false, reason: `title: excluded (${hit.source})` };
  if (cfg.skipJuniorTitles && belowMiddle(title)) return { pass: false, reason: 'title: trainee / intern / junior role' };
  return { pass: true };
}

/** Largest number of years the posting asks for anywhere; ranges ("3–5 years") count as their lower bound. */
export function requiredYears(text: string): number | null {
  const flattened = text.replace(/(\d{1,2})\s*(?:[-–—]|to|до)\s*\d{1,2}(?=\s*\+?\s*(?:years?|yrs|рок|рік))/gi, '$1');
  let max: number | null = null;
  for (const m of flattened.matchAll(/(\d{1,2})\s*\+?\s*(?:years?|yrs|років|роки|рік)/gi)) {
    const context = flattened.slice(m.index ?? 0, (m.index ?? 0) + 90);
    if (/(experience|досвід|commercial|комерційн|in |with |of )/i.test(context)) max = Math.max(max ?? 0, Number(m[1]));
  }
  return max;
}

export function locationCheck(text: string, loc: LocationPrefs): PrefilterResult {
  const names = loc.commuteCities.flatMap((c) => CITY_ALIASES[c.toLowerCase()] ?? [c.toLowerCase()]);
  if (names.length > 0 && new RegExp(`(?<!\\p{L})(${names.join('|')})(?!\\p{L})`, 'iu').test(text)) return { pass: true };
  if (loc.remote && REMOTE.test(text) && !NO_REMOTE.test(text)) return { pass: true };
  if (NO_REMOTE.test(text) || ONSITE.test(text)) return { pass: false, reason: 'location: on-site outside your commute cities' };
  return { pass: true };
}
