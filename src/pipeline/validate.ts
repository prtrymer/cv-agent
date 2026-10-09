import { detectTech, labelOf } from '../profile/lexicon.js';
import { durationMonths, durationText, excludedFor, findGaps, FRAMEWORK_SLOT, parseYm, type Knowledge, type Ym } from '../profile/profile.js';
import type { RoleFamily } from '../types.js';

export interface Plan {
  headline: string;
  summary: string;
  entries: Array<{ engagement: string; bullets: Array<{ id: string; text: string | null }> }>;
  omit: string[];
  skills_first: string[];
  include_ai_section: boolean;
  cover_letter: { intro: string; snapshot: string; before: string | null; proof: string | null };
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\btailor(ed|ing)?\b/i, 'never use the word "tailored" — the documents are never described as tailored for the role'],
  [/\b(customi[sz]ed|adapted)\s+(for|to)\s+(this|the|your)\s+(role|position|vacancy|job)\b/i, 'never say the documents were customised for the role'],
  [/\b(concurrently with|in parallel (with|to) (another|other|my)|at the same time as (another|my)|dual[- ]engagement|overlapping (engagements|roles|placements)|two (jobs|roles|engagements|clients) at (once|the same time)|alongside my (other|main) (role|job|engagement))\b/i, 'never mention overlapping or concurrent engagements'],
  [/\b(lacking|no (commercial |hands-on |prior |production )?experience|limited experience|not (yet )?(familiar|experienced)|unfortunately|although I (don't|do not|haven't|have not)|I have yet to|still learning|beginner (in|with))\b/i, 'positive-only: never mention gaps, weaknesses or missing skills'],
];
const ABBREV = /\b(e\.g|i\.e|etc|vs|approx|Sc|Ltd|Inc)\./g;
const THESIS = /(thesis|diploma|b\.?sc|bachelor|university|дипломн)/i;
const PERSONAL = /(personal|pet project|side project)/i;

const sentences = (text: string): string[] => text.replace(ABBREV, '$1').split(/(?<=[.!?])\s+/).filter((s) => s.trim());
const numbersIn = (text: string): string[] => text.match(/\d+(?:\.\d+)?/g) ?? [];

/** Every rule the JSON schema can't express: grounding against the fact base, CV format, positive-only. */
export function validatePlan(plan: Plan, k: Knowledge, lang: 'en' | 'uk', family: RoleFamily, wanted: Set<string> = new Set()): string[] {
  const errs: string[] = [];
  const seenEngagements = new Set<string>();
  const seenBullets = new Set<string>();

  const fam = k.families.get(family);
  const excluded = excludedFor(fam, wanted);
  const offFamily = (text: string): string[] => [...detectTech(text)].filter((id) => excluded.has(id)).map(labelOf);

  for (const [i, entry] of plan.entries.entries()) {
    const where = `entries[${i}]`;
    const eng = k.engagements.get(entry.engagement);
    if (!eng) { errs.push(`${where}: unknown engagement "${entry.engagement}"`); continue; }
    if (seenEngagements.has(eng.id)) errs.push(`${where}: "${eng.id}" appears twice`);
    seenEngagements.add(eng.id);

    for (const [j, b] of entry.bullets.entries()) {
      const bw = `${where}.bullets[${j}]`;
      const bank = k.bullets.get(b.id);
      if (!bank || bank.engagement !== eng.id) { errs.push(`${bw}: bullet "${b.id}" does not belong to ${eng.id}`); continue; }
      if (seenBullets.has(b.id)) errs.push(`${bw}: bullet "${b.id}" used twice`);
      seenBullets.add(b.id);
      if (b.text !== null) errs.push(...checkRewrite(b.text, bank.text, eng.id, eng.company, k).map((m) => `${bw}.text: ${m}`));
      const off = offFamily(b.text ?? bank.text);
      if (off.length) errs.push(`${bw}: "${b.id}" is about ${off.join(', ')} — this is a ${family} CV, pick another bullet or leave the engagement out`);
    }
  }

  const included: Array<[Ym, Ym]> = plan.entries
    .map((e) => k.engagements.get(e.engagement))
    .filter((e): e is NonNullable<typeof e> => Boolean(e))
    .map((e) => [parseYm(e.start, 'start', k.now), parseYm(e.end, 'end', k.now)]);
  const now: Ym = { y: k.now.getUTCFullYear(), m: k.now.getUTCMonth() + 1 };
  for (const gap of findGaps(included, now, k.maxGapMonths)) {
    errs.push(`timeline: the engagements you kept leave a ${gap.months}-month gap (${gap.from} → ${gap.to}) — include one that covers it`);
  }

  if (fam && !plan.headline.startsWith(`${fam.headline} · `)) errs.push(`headline: start with "${fam.headline} · " (role family ${family})`);
  for (const word of k.profile.positioning.never_in_headline) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(plan.headline)) errs.push(`headline: "${word}" is not a title he holds — leave it out`);
  }
  errs.push(...checkProse(plan.headline, 'headline', k));
  errs.push(...checkProse(plan.summary, 'summary', k));

  const cl = plan.cover_letter;
  for (const [name, value] of [['headline', plan.headline], ['summary', plan.summary], ...Object.entries(cl).map(([n, v]) => [`cover_letter.${n}`, v])] as Array<[string, string | null]>) {
    const off = value ? offFamily(value) : [];
    if (off.length) errs.push(`${name}: mentions ${off.join(', ')} — this is a ${family} application, leave it out`);
    if (lang === 'uk' && value && name.startsWith('cover_letter')) errs.push(...englishIn(value, name, k));
  }
  for (const [name, value] of Object.entries(cl)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    errs.push(...checkProse(value, `cover_letter.${name}`, k));
    if (/\battach(ed|ment|ments)\b/i.test(value)) errs.push(`cover_letter.${name}: don't mention attachments — the closing line is added by code`);
  }
  for (const [name, value] of [['summary', plan.summary], ...Object.entries(cl)] as Array<[string, string | null]>) {
    if (value) errs.push(...checkDurations(value, name === 'summary' ? 'summary' : `cover_letter.${name}`, k));
  }
  if (/^\s*(hi|hello|dear|привіт|вітаю|добрий)\b/i.test(cl.intro)) errs.push('cover_letter.intro: the greeting is added by code — start with the sentence itself');
  if (lang === 'en' && !/^\s*quick snapshot:/i.test(cl.snapshot)) errs.push('cover_letter.snapshot: begin with "Quick snapshot:"');
  if (lang === 'uk' && /^\s*quick snapshot/i.test(cl.snapshot)) errs.push('cover_letter.snapshot: a Ukrainian letter begins this with «Коротко:», not English');
  if (lang === 'uk' && cl.before && /^\s*before that/i.test(cl.before)) errs.push('cover_letter.before: a Ukrainian letter begins this with «До цього:», not English');
  if (lang === 'en' && cl.before && !/^\s*before that:/i.test(cl.before)) errs.push('cover_letter.before: begin with "Before that:"');


  const everything = [plan.headline, plan.summary, ...plan.entries.flatMap((e) => e.bullets.map((b) => b.text ?? '')), cl.intro, cl.snapshot, cl.before ?? '', cl.proof ?? ''].join('\n');
  for (const [re, msg] of FORBIDDEN) if (re.test(everything)) errs.push(msg);
  if (everything.includes(FRAMEWORK_SLOT)) errs.push(`write ${FRAMEWORK_SLOT} as the framework <task> names, never the placeholder itself`);

  return [...new Set(errs)];
}

const WORD_NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, half: 0.5 };
const DURATION = /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+(?:\.\d+)?)(\s+and\s+a\s+half)?[\s-]+(year|month)s?\b/gi;
const UA_NUM: Record<string, number> = { один: 1, одна: 1, два: 2, дві: 2, три: 3, чотири: 4, шість: 6, сім: 7, вісім: 8, десять: 10, одинадцять: 11, дванадцять: 12, півтора: 1.5, пів: 0.5 };
const UA_DURATION = /(?<![\p{L}\d])(?:(\d+(?:[.,]\d+)?|один|одна|два|дві|три|чотири|п['ʼ’]ять|шість|сім|вісім|дев['ʼ’]ять|десять|одинадцять|дванадцять|півтора|пів)\s*)?(рік|року|роки|років|роками|роком|місяць|місяця|місяці|місяців|місяцями)(?![\p{L}])/giu;

/** Every "a year" / "eight months" / "два роки" / "9 місяців" in a text, in months. Calendar years ("з 2023 року") are not durations. */
function findDurations(text: string): Array<{ index: number; text: string; months: number }> {
  const out: Array<{ index: number; text: string; months: number }> = [];
  for (const m of text.matchAll(DURATION)) {
    const n = (WORD_NUM[m[1].toLowerCase()] ?? Number(m[1])) + (m[2] ? 0.5 : 0);
    out.push({ index: m.index ?? 0, text: m[0], months: m[3].toLowerCase() === 'year' ? n * 12 : n });
  }
  for (const m of text.matchAll(UA_DURATION)) {
    const word = (m[1] ?? '').toLowerCase().replace(/['ʼ’]/g, '');
    const n = !m[1] ? 1 : word === 'пять' ? 5 : word === 'девять' ? 9 : UA_NUM[word] ?? Number(word.replace(',', '.'));
    if (!Number.isFinite(n) || n > 50) continue;
    out.push({ index: m.index ?? 0, text: m[0], months: /^р/i.test(m[2]) ? n * 12 : n });
  }
  out.sort((a, b) => a.index - b.index);
  // "2 роки 4 місяці", "рік і дев'ять місяців", "a year and eight months": one duration, not a year and then a month count.
  const merged: typeof out = [];
  for (const d of out) {
    const prev = merged[merged.length - 1];
    const gap = prev ? text.slice(prev.index + prev.text.length, d.index) : '';
    if (prev && prev.months % 12 === 0 && d.months < 12 && /^\s*(?:,|і|й|та|and)?\s*$/iu.test(gap)) {
      prev.text = text.slice(prev.index, d.index + d.text.length);
      prev.months += d.months;
    } else merged.push({ ...d });
  }
  return merged;
}

/** The voice sample with its durations blanked: they describe an older letter, and the model kept copying them. */
export const maskDurations = (text: string): string => text.replace(DURATION, '[duration]');

/**
 * Durations stated in words ("a year on…", "eight months of…") must match the engagement they describe — found in
 * the words after the duration, up to the next one: its company, its keywords, or a technology only it used
 * ("Elixir" → yolo). When nothing points to one engagement, some engagement or the total must match. The voice
 * sample's durations are illustrative, and copying one ("a year on an Elixir platform" for a 2-year engagement)
 * was the first real mistake the model made.
 */
function checkDurations(text: string, where: string, k: Knowledge): string[] {
  return sentences(text).flatMap((s) => durationChecks(s, k)).flatMap((d) => (d.problem ? [`${where}: ${d.problem}`] : []));
}

/** Each duration in one sentence, with why it doesn't match the fact base (null when it does). */
function durationChecks(sentence: string, k: Knowledge): Array<{ index: number; text: string; problem: string | null }> {
  const months = new Map([...k.engagements.values()].map((e) => [e.id, durationMonths(e, k.now)]));
  const owners = new Map<string, string[]>();
  for (const [id, scope] of k.scopes) for (const t of scope) owners.set(t, [...(owners.get(t) ?? []), id]);
  const fits = (r: number, n: number) => Math.abs(r - n) <= Math.max(2, r * 0.15);
  const mentions = (segment: string): Set<string> => {
    const s = segment.toLowerCase();
    const about = new Set<string>();
    for (const e of k.engagements.values()) {
      if ([e.company, ...e.keywords].some((w) => new RegExp(`(?<![\\p{L}\\d])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d])`, 'u').test(s))) about.add(e.id);
    }
    for (const t of detectTech(segment)) { const o = owners.get(t); if (o?.length === 1) about.add(o[0]); }
    return about;
  };
  const found = findDurations(sentence);
  return found.map((m, i) => {
    const said = m.months;
    if (Math.abs(said - k.totalYears * 12) <= 6) return { ...m, problem: null };
    const about = mentions(sentence.slice(m.index, found[i + 1]?.index ?? sentence.length));
    const candidates = about.size ? [...about] : [...months.keys()];
    if (candidates.some((id) => fits(months.get(id)!, said))) return { ...m, problem: null };
    const which = about.size ? ` (${[...about].map((id) => `${id} lasted ${durationText(months.get(id)!)}`).join('; ')})` : '';
    return { ...m, problem: `"${m.text}" doesn't match the fact base${which} — use the durations there, or leave it out` };
  });
}

/**
 * The text with every duration that matches the fact base blanked out. "11 місяців" for an engagement dated
 * 2023-03 – 2024-01 is grounded in the dates, though the number 11 is written nowhere in the profile.
 */
function withoutGroundedDurations(text: string, k: Knowledge): string {
  return sentences(text).map((s) => durationChecks(s, k).reverse()
    .reduce((t, d) => (d.problem ? t : `${t.slice(0, d.index)}[duration]${t.slice(d.index + d.text.length)}`), s)).join(' ');
}

/**
 * A Ukrainian letter must not slip into English: five or more English words in a row that aren't technology or
 * product names ("So picking up new stacks isn't a claim…") is an English sentence.
 */
function englishIn(text: string, where: string, k: Knowledge): string[] {
  const names = new Set([...k.engagements.values()].flatMap((e) => e.company.toLowerCase().split(/\s+/)));
  const words = text.split(/\s+/);
  const runs: string[] = [];
  let run: string[] = [];
  const flush = () => { if (run.length >= 5) runs.push(run.join(' ')); run = []; };
  for (const w of words) {
    const bare = w.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '');
    const latin = /^[A-Za-z][A-Za-z'’-]*$/.test(bare);
    if (latin && detectTech(bare).size === 0 && !names.has(bare.toLowerCase())) run.push(bare);
    else flush();
  }
  flush();
  return runs.map((r) => `${where}: "${r}" is English — a Ukrainian letter stays Ukrainian (only technology and company names in English)`);
}

function checkRewrite(text: string, bank: string, engagementId: string, company: string, k: Knowledge): string[] {
  const out: string[] = [];
  if (!text.includes(' — ')) out.push('keep the problem — tools — outcome shape with a spaced em dash');
  if (!/[.!]$/.test(text.trim())) out.push('end with a period');
  if (sentences(text).length > 1) out.push('one sentence only');
  if (text.length > Math.max(330, bank.length * 1.4)) out.push('too long — stay close to the bank bullet');
  const scope = k.scopes.get(engagementId) ?? new Set<string>();
  for (const id of detectTech(text)) {
    if (k.neverClaim.has(id)) out.push(`mentions ${labelOf(id)}, which he has never used`);
    else if (!scope.has(id)) out.push(`mentions ${labelOf(id)}, which is not in ${company}'s stack`);
  }
  for (const n of numbersIn(text)) if (!k.allowedNumbers.has(n)) out.push(`the number "${n}" is not in the fact base`);
  return out;
}

/** Grounding for any prose that makes claims: technologies, thesis-only and personal-only tech, years, numbers. */
export function checkProse(text: string, where: string, k: Knowledge): string[] {
  const out: string[] = [];
  for (const sentence of sentences(text)) {
    for (const id of detectTech(sentence)) {
      if (k.neverClaim.has(id)) out.push(`${where}: mentions ${labelOf(id)}, which he has never used`);
      else if (!k.global.has(id)) out.push(`${where}: mentions ${labelOf(id)}, which is not in the fact base`);
      else if (k.academic.has(id) && !THESIS.test(sentence)) out.push(`${where}: ${labelOf(id)} is from the thesis project — only mention it in a sentence about the thesis`);
      else if (k.personalOnly.has(id) && !PERSONAL.test(sentence)) out.push(`${where}: ${labelOf(id)} is personal-project only — say so or leave it out`);
    }
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs|років|роки|рік)/gi)) {
    if (Number(m[1]) > k.totalYears) out.push(`${where}: claims ${m[1]} years — his total is ${k.totalYears}`);
  }
  for (const n of numbersIn(withoutGroundedDurations(text, k))) if (!k.allowedNumbers.has(n)) out.push(`${where}: the number "${n}" is not in the fact base`);
  return out;
}
