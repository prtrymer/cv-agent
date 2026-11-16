import type { Config } from '../config.js';

export type PrefilterResult = { pass: true } | { pass: false; reason: string };
export interface LocationPrefs { commuteCities: string[]; remote: boolean }

const CITY_ALIASES: Record<string, string[]> = {
  olomouc: ['olomouc', 'оломоуц'],
  prague: ['prague', 'praha', 'прага', 'praze'],
  brno: ['brno', 'брно', 'brně'],
  ostrava: ['ostrava', 'острава', 'остраві', 'ostravě'],
  plzen: ['plzeň', 'plzen', 'пльзень', 'plzni'],
};
export const REMOTE = /(remote|віддален|дистанц|удален|home[- ]office|work from home|anywhere)/i;
export const NO_REMOTE = /(no remote|not remote|without remote|on-?site only|office only|лише офіс|тільки офіс|без віддален)/i;
/** Hybrid as a way of working. "Hybrid cloud", "hybrid Kubernetes" and "гібридним хмарним з'єднанням" are infrastructure. */
const HYBRID_WORK = [
  String.raw`hybrid\s+(?:work|format|mode|model|schedule|office|role|position|job|setup|arrangement|employment|basis)`,
  String.raw`\b(?:work(?:ing|s)?|format|schedule|mode|model)\s*[:-]?\s*hybrid`,
  String.raw`\(hybrid\b`,
  String.raw`hybrid[,:]?\s+(?:in\s+[A-ZА-Я]|\d)`,
  String.raw`^\s*hybrid\s*$`,
  String.raw`гібрид(?:\s|[.,;:)]|$)`,
  String.raw`гібридн\S*\s+(?:формат|режим|графік|робот|модел)`,
  String.raw`(?:формат|режим|графік)\S*(?:\s+роботи)?\s*[:–—-]?\s*гібрид`,
].join('|');
const ONSITE = new RegExp(`(on-?site|in[- ]office|office in|our office|офіс|relocation required|${HYBRID_WORK})`, 'im');

/** Deterministic and free: everything dropped here never reaches the model. */
export function prefilter(v: { title: string; location: string | null; text: string }, cfg: Config['prefilter'], loc: LocationPrefs, min: MinSeniority): PrefilterResult {
  const byTitle = titleCheck(v.title, cfg, min);
  if (!byTitle.pass) return byTitle;

  const years = requiredYears(v.text);
  if (years !== null && years > cfg.maxYearsRequired) return { pass: false, reason: `asks for ${years}+ years` };

  return locationCheck(`${v.location ?? ''}\n${v.text.slice(0, 2500)}`, loc);
}

const ENTRY = /(?<![\p{L}])(trainee|intern|internship|apprentice|graduate|стажер|стажист|стажування|практикант)(?![\p{L}])/iu;
const JUNIOR = /(?<![\p{L}])(junior|jr\.?|entry[- ]level|джуніор|молодший)(?![\p{L}])/iu;
const MIDDLE_UP = /(?<![\p{L}])(middle|mid|senior|strong|lead|сеньйор|мідл)(?![\p{L}])/iu;
export type MinSeniority = Config['pipeline']['minSeniority'];
const RANK = { entry: 0, junior: 1, middle: 2, senior: 3, lead: 4 } as const;

/**
 * What a title alone says about seniority: trainee/intern only, junior ("Trainee/Junior" is open to juniors;
 * "Junior+/Middle" is not junior-only), or nothing.
 */
export function titleSeniority(title: string): 'entry' | 'junior' | null {
  const entry = ENTRY.test(title), junior = JUNIOR.test(title);
  if (entry && !junior) return 'entry';
  return entry || (junior && !MIDDLE_UP.test(title)) ? 'junior' : null;
}

/** Below `pipeline.minSeniority`? Trainee/intern titles always are; an unknown seniority never is. */
export function belowSeniority(seniority: string | null | undefined, min: MinSeniority): boolean {
  const r = seniority ? RANK[seniority as keyof typeof RANK] : undefined;
  return r !== undefined && r < RANK[min];
}

/** The free title rule: drops titles below `pipeline.minSeniority` before any model call. */
export function seniorityCheck(title: string, min: MinSeniority): PrefilterResult {
  const s = titleSeniority(title);
  if (!belowSeniority(s, min)) return { pass: true };
  return { pass: false, reason: s === 'entry' ? 'title: trainee / intern role' : `title: ${s} role (pipeline.minSeniority: ${min})` };
}

/** The title rules alone — also used by job-board sources to skip irrelevant jobs before fetching their details. */
export function titleCheck(title: string, cfg: Config['prefilter'], min: MinSeniority): PrefilterResult {
  const include = cfg.titleInclude.map((s) => new RegExp(s, 'i'));
  const exclude = cfg.titleExclude.map((s) => new RegExp(s, 'i'));
  if (include.length > 0 && !include.some((r) => r.test(title))) return { pass: false, reason: 'title: not a matching role' };
  const hit = exclude.find((r) => r.test(title));
  if (hit) return { pass: false, reason: `title: excluded (${hit.source})` };
  return seniorityCheck(title, min);
}

/**
 * "An outstaffing company with 23+ years of experience", "With 10 years of experience and 70+ completed projects, we…",
 * "For more than 30 years, we have been creating…", "over the past 11 years", "25 years of history", "a team with 15+ years".
 */
const COMPANY_AGE = /(compan|agency|outsourc|outstaff|founded|on the market|in business|completed projects|clients|компані|агенці|на ринку|years of history|years of [\w ]*expertise|backed by|team[^.;]* with \d{1,2}\+? years|\b(?:for|past|last)(?: (?:more than|over))? \d{1,2}\+? years|рок(?:ів|и) ми(?=\s))/i;
const ASKS_CANDIDATE = /(\byou|candidate|looking for|we expect|requir|must|should|need|ви\b|ваш|шукаємо|очікуємо|вимог)/i;
/** "with over 12 years of experience in the market, is looking for…": years in a market are the company's, whatever else the sentence asks. */
const MARKET_AGE = /^\d{1,2}\s*\+?\s*(?:years?|yrs|років|роки|рік)[^.;\n]{0,40}?(?:\b(?:in|on) the (?:\w+ ){0,2}market\b|на ринку)/i;

/** Largest number of years the posting asks for anywhere; ranges ("3–5 years") count as their lower bound. */
export function requiredYears(text: string): number | null {
  const flattened = text.replace(/(\d{1,2})\s*(?:[-–—]|to|до)\s*\d{1,2}(?=\s*\+?\s*(?:years?|yrs|рок|рік))/gi, '$1');
  let max: number | null = null;
  for (const m of flattened.matchAll(/(\d{1,2})\s*\+?\s*(?:years?|yrs|років|роки|рік)/gi)) {
    const at = m.index ?? 0;
    const context = flattened.slice(at, at + 90);
    if (!/(experience|досвід|commercial|комерційн|in |with |of )/i.test(context) || MARKET_AGE.test(context)) continue;
    // The company bragging about its own age is not a requirement.
    const start = Math.max(flattened.lastIndexOf('\n', at), flattened.slice(0, at).search(/[.!?;][^.!?;]*$/)) + 1;
    const end = flattened.slice(at).search(/[.!?;\n]/);
    const sentence = flattened.slice(start, end < 0 ? undefined : at + end);
    if (COMPANY_AGE.test(sentence) && !ASKS_CANDIDATE.test(sentence)) continue;
    max = Math.max(max ?? 0, Number(m[1]));
  }
  return max;
}

const PRESENCE = new RegExp(`(on-?site|${HYBRID_WORK})`, 'im');
const OPTIONAL = /(possib|option|flexible|можлив|гнучк)/i;

/** Listed as remote, and every line about on-site or hybrid work offers it rather than requires it. */
export function presenceOptional(location: string | null, text: string): boolean {
  if (!REMOTE.test(location ?? '') || NO_REMOTE.test(text)) return false;
  return text.split('\n').filter((line) => PRESENCE.test(line)).every((line) => OPTIONAL.test(line));
}

/**
 * "Hybrid in Dubai or Madrid, remote anywhere in the EU": remote work offered across a region that includes Czechia.
 * The model filed the hybrid offices as a blocker and the remote option was lost (2026-11-11).
 * "Western Europe" and single countries other than Czechia don't count.
 */
const REMOTE_EUROPE = /\bremote\b[^.;\n]{0,30}?\b(?:in|within|across|from|throughout)\s+(?:the\s+)?(?:EU|EEA|European Union|European Economic Area|Europe|CET|CEST|Czechia|Czech Republic)\b|\b(?:EU|EEA|Europe|European)[- ](?:wide\s+)?remote\b/i;

export function remoteInEurope(location: string | null, text: string): boolean {
  const all = `${location ?? ''}\n${text}`;
  return REMOTE_EUROPE.test(all) && !NO_REMOTE.test(all);
}

/** Whether the text names one of the commute cities, in any of its spellings (Prague, Praha, Прага…). */
export function namesCommuteCity(text: string, commuteCities: string[]): boolean {
  const names = commuteCities.flatMap((c) => CITY_ALIASES[c.toLowerCase()] ?? [c.toLowerCase()]);
  return names.length > 0 && new RegExp(`(?<!\\p{L})(${names.join('|')})(?!\\p{L})`, 'iu').test(text);
}

export function locationCheck(text: string, loc: LocationPrefs): PrefilterResult {
  if (namesCommuteCity(text, loc.commuteCities)) return { pass: true };
  if (loc.remote && REMOTE.test(text) && !NO_REMOTE.test(text)) return { pass: true };
  if (NO_REMOTE.test(text) || ONSITE.test(text)) return { pass: false, reason: 'location: on-site outside your commute cities' };
  return { pass: true };
}
