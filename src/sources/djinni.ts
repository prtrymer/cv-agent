import type { Config } from '../config.js';
import type { PrefilterResult } from '../pipeline/prefilter.js';
import { extractJobPosting } from './manual.js';

/**
 * The hard requirements a Djinni company sets, from the sidebar of the public job page. Djinni enforces them: a
 * profile below the years or outside the countries gets no reply form at all ("Ваш профіль не відповідає…").
 */
export interface DjinniRequirements {
  /** Fewest years Djinni lets through: "Considering with N years" when given, else "from N years". */
  minYears: number | null;
  /** "Countries where we consider candidates", as written ("Ukraine", "Countries of Europe or Ukraine"). */
  countries: string | null;
  /** The hiring company from the page's schema.org JobPosting: Djinni's RSS never names it. */
  company: string | null;
}

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const years = (s: string): number | null => (/no experience|without experience/i.test(s) ? 0 : Number(/(\d+)\s*years?/i.exec(s)?.[1] ?? NaN));

export function parseDjinniRequirements(html: string): DjinniRequirements {
  const aside = /<aside>([\s\S]*?)<\/aside>/i.exec(html)?.[1] ?? '';
  const from = /<strong[^>]*>([^<]*\bexperience\b[^<]*)<\/strong>/i.exec(aside)?.[1];
  const considering = /<small[^>]*>\s*(Considering with[^<]*)<\/small>/i.exec(aside)?.[1];
  const place = /<span class="location-text">([\s\S]*?)<\/span>\s*<\/strong>\s*<div[^>]*>\s*Countries where we consider candidates/i.exec(aside)?.[1];
  const min = considering !== undefined ? years(considering) : from !== undefined ? years(from) : null;
  return { minYears: min !== null && Number.isFinite(min) ? min : null, countries: place ? text(place) : null, company: extractJobPosting(html)?.company ?? null };
}

/** Would Djinni let you reply? Unknown requirements pass: only what the page states is held against a vacancy. */
export function djinniCheck(r: DjinniRequirements, cfg: Config['prefilter']['djinni']): PrefilterResult {
  if (r.minYears !== null && r.minYears > cfg.experienceYears) {
    return { pass: false, reason: `djinni: needs ${r.minYears}+ years (your Djinni profile: ${cfg.experienceYears})` };
  }
  if (r.countries && !cfg.countries.some((c) => new RegExp(c, 'i').test(r.countries!))) {
    return { pass: false, reason: `djinni: candidates only from ${r.countries}` };
  }
  return { pass: true };
}
