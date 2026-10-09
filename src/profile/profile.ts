import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { ROLE_FAMILIES, type RoleFamily } from '../types.js';
import { idsOf } from './lexicon.js';

const DateStr = z.union([z.string(), z.number()]).transform((v) => String(v));
const BulletSchema = z.object({ id: z.string(), text: z.string(), tags: z.array(z.string()).default([]), check: z.string().optional() });

export const ProfileSchema = z.object({
  person: z.object({
    name: z.string(), headline: z.string(), location: z.string(),
    links: z.object({ github: z.string(), live_projects: z.array(z.string()).default([]) }),
    career_start: DateStr,
  }),
  positioning: z.object({
    default: z.string(), java_pivot: z.string().optional(), never_in_headline: z.array(z.string()).default([]),
    families: z.record(z.string(), z.object({ headline: z.string(), angle: z.string(), titles: z.array(z.string()).default([]), exclude: z.array(z.string()).default([]) })).default({}),
  }),
  summary: z.object({ master: z.string() }),
  groups: z.array(z.object({ id: z.string(), name: z.string(), title: z.string(), start: DateStr, end: DateStr, blurb: z.string().default('') })).default([]),
  engagements: z.array(z.object({
    id: z.string(), group: z.string().optional(), company: z.string(), product: z.string().optional(),
    titles: z.array(z.string()).min(1), tagline: z.string().default(''), keywords: z.array(z.string()).default([]),
    start: DateStr, end: DateStr, omit_ok: z.boolean().default(false),
    context: z.string().default(''), stack: z.array(z.string()), bullets: z.array(BulletSchema).min(1),
    frameworks: z.object({ options: z.array(z.string()).min(1), default: z.array(z.string()).min(1) }).optional(),
  })).min(1),
  education: z.object({
    degree: z.string(), school: z.string(), faculty: z.string().optional(), start: DateStr, end: DateStr,
    projects: z.array(z.object({ id: z.string(), title: z.string(), stack: z.array(z.string()), academic_only: z.array(z.string()).default([]), text: z.string() })).default([]),
  }),
  ai_agent_section: z.object({ master: z.string() }),
  skills: z.array(z.object({ group: z.string(), items: z.array(z.string()) })),
  languages: z.array(z.object({ name: z.string(), level: z.string() })),
  guardrails: z.object({ never_mention: z.array(z.string()).default([]), never_claim: z.array(z.string()).default([]), personal_only: z.array(z.string()).default([]) }),
});
export type Profile = z.infer<typeof ProfileSchema>;
export type Engagement = Profile['engagements'][number];
export type Family = Profile['positioning']['families'][string];

export const AnswersSchema = z.looseObject({
  contact: z.looseObject({
    full_name: z.string(), email: z.string(), phone: z.string(), phone_alt: z.string().optional(),
    city: z.string(), country: z.string(), github: z.string(), linkedin: z.string().optional(),
  }),
  eligibility: z.record(z.string(), z.unknown()),
  logistics: z.record(z.string(), z.unknown()),
});
export type Answers = z.infer<typeof AnswersSchema>;

function readYaml<T>(file: string, schema: z.ZodType<T>): { data: T; raw: string } {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = schema.safeParse(YAML.parse(raw));
  if (!parsed.success) throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  return { data: parsed.data, raw };
}
export const loadProfile = (file: string): { data: Profile; raw: string } => readYaml(file, ProfileSchema);
export const loadAnswers = (file: string): Answers => readYaml(file, AnswersSchema).data;

export interface Ym { y: number; m: number }
export const ymIdx = (a: Ym): number => a.y * 12 + (a.m - 1);
export const ymLabel = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

/** Year-only dates resolve conservatively (late start, early end) so no computed duration ever overstates. */
export function parseYm(s: string, edge: 'start' | 'end', now: Date): Ym {
  if (s.trim() === 'present') return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 };
  const m = /^(\d{4})(?:-(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new Error(`unrecognised date "${s}" (use YYYY-MM, YYYY or present)`);
  const y = Number(m[1]);
  if (m[2]) return { y, m: Number(m[2]) };
  return edge === 'start' ? { y, m: 12 } : { y, m: 1 };
}

export const rangeOf = (e: { start: string; end: string }, now: Date): [Ym, Ym] => [parseYm(e.start, 'start', now), parseYm(e.end, 'end', now)];

export function mergedMonths(ranges: Array<[Ym, Ym]>): number {
  const iv = ranges.map(([a, b]) => [ymIdx(a), ymIdx(b)] as [number, number]).filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  let total = 0, start = -1, end = -2;
  for (const [s, e] of iv) {
    if (s > end + 1) { if (start >= 0) total += end - start + 1; start = s; end = e; }
    else end = Math.max(end, e);
  }
  if (start >= 0) total += end - start + 1;
  return total;
}

export function findGaps(ranges: Array<[Ym, Ym]>, until: Ym, maxGap: number): Array<{ from: string; to: string; months: number }> {
  const iv = ranges.map(([a, b]) => [ymIdx(a), ymIdx(b)] as [number, number]).sort((x, y) => x[0] - y[0]);
  if (iv.length === 0) return [];
  const gaps: Array<{ from: string; to: string; months: number }> = [];
  let end = iv[0][1];
  for (const [s, e] of iv.slice(1)) {
    const months = s - end - 1;
    if (months > maxGap) gaps.push({ from: ymLabel(end + 1), to: ymLabel(s - 1), months });
    end = Math.max(end, e);
  }
  const tail = ymIdx(until) - end;
  if (tail > maxGap) gaps.push({ from: ymLabel(end + 1), to: ymLabel(ymIdx(until)), months: tail });
  return gaps;
}

export const halfYears = (months: number): number => Math.floor((months / 12) * 2) / 2;

export function totalYears(p: Profile, now: Date): number {
  const start = parseYm(p.person.career_start, 'start', now);
  return halfYears(ymIdx({ y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 }) - ymIdx(start) + 1);
}

/** Years with one technology: merged engagement ranges whose stack (or framework options) lists it. Used for form answers. */
export function yearsWithTech(p: Profile, tech: string, now: Date): number {
  const wanted = idsOf([tech]);
  if (wanted.size === 0) return 0;
  const ranges = p.engagements.filter((e) => [...idsOf([...e.stack, ...(e.frameworks?.options ?? [])])].some((id) => wanted.has(id))).map((e) => rangeOf(e, now));
  return halfYears(mergedMonths(ranges));
}

export interface Knowledge {
  profile: Profile; answers: Answers; profileRaw: string; now: Date;
  engagements: Map<string, Engagement>;
  bullets: Map<string, { engagement: string; text: string }>;
  scopes: Map<string, Set<string>>;
  global: Set<string>; academic: Set<string>; personalOnly: Set<string>; neverClaim: Set<string>;
  allowedNumbers: Set<string>; skillItems: Set<string>;
  totalYears: number; maxGapMonths: number;
  location: { commuteCities: string[]; remote: boolean; relocate: boolean };
  families: Map<RoleFamily, Family>;
}

/** The job title printed for an engagement: the family's first preference that engagement allows, else its first title. */
export const titleFor = (e: Engagement, f: Family | undefined): string => f?.titles.find((t) => e.titles.includes(t)) ?? e.titles[0];

/** Technology ids a family's CV never shows (Java on a TypeScript CV) — unless the vacancy itself asks for them ("Node.js + Java"). */
export const excludedFor = (f: Family | undefined, wanted: Set<string> = new Set()): Set<string> =>
  new Set([...idsOf(f?.exclude ?? [])].filter((id) => !wanted.has(id)));

/** How long an engagement ran, in months (conservative for year-only dates, like every other duration here). */
export const durationMonths = (e: { start: string; end: string }, now: Date): number => {
  const [a, b] = rangeOf(e, now);
  return Math.max(1, ymIdx(b) - ymIdx(a) + 1);
};

/** "1 year", "2 years 4 months", "8 months" — the wording the tailoring prompt is given for each engagement. */
export function durationText(months: number): string {
  const y = Math.floor(months / 12), m = months % 12;
  const parts = [y ? `${y} year${y > 1 ? 's' : ''}` : '', m ? `${m} month${m > 1 ? 's' : ''}` : ''].filter(Boolean);
  return parts.join(' ') || '1 month';
}

/**
 * The skills-list item a name refers to ("WebSockets" → "WebSocket", "AWS" → "AWS (S3, Lambda, EKS, DynamoDB)",
 * "Redux" → "Redux/RTK"), or null. Used for ordering skills, so a near miss costs nothing and claims nothing.
 */
export function resolveSkill(name: string, items: string[]): string | null {
  const n = name.toLowerCase().trim();
  const bare = (s: string) => s.toLowerCase().replace(/\s*\(.*\)\s*$/, '').trim();
  return items.find((i) => i.toLowerCase() === n)
    ?? items.find((i) => bare(i) === n || bare(i) === n.replace(/s$/, '') || `${bare(i)}s` === n)
    ?? items.find((i) => bare(i).split(/\s*\/\s*/).includes(n.replace(/s$/, '')) || bare(i).split(/\s*\/\s*/).includes(n))
    ?? null;
}

/** Commercial years with each of the given technologies, skipping the ones never used. */
export function yearsByTech(p: Profile, techs: string[], now: Date): Array<[string, number]> {
  return techs.map((t) => [t, yearsWithTech(p, t, now)] as [string, number]).filter(([, y]) => y > 0);
}

const isYes = (v: unknown): boolean => v === true || /^(yes|true)$/i.test(String(v ?? ''));

export function buildKnowledge(profile: Profile, answers: Answers, profileRaw: string, opts: { now: Date; maxGapMonths: number }): Knowledge {
  const engagements = new Map(profile.engagements.map((e) => [e.id, e]));
  const bullets = new Map<string, { engagement: string; text: string }>();
  for (const e of profile.engagements) {
    for (const b of e.bullets) {
      if (bullets.has(b.id)) throw new Error(`duplicate bullet id "${b.id}" in ${profile.person.name}'s profile`);
      bullets.set(b.id, { engagement: e.id, text: b.text });
    }
  }
  const scopes = new Map(profile.engagements.map((e) => [e.id, idsOf(e.stack)] as const));
  const academic = idsOf(profile.education.projects.flatMap((p) => p.academic_only));
  const neverClaim = idsOf([...profile.guardrails.never_claim, ...profile.guardrails.never_mention]);
  const personalOnly = idsOf(profile.guardrails.personal_only);
  const global = new Set<string>([
    ...[...scopes.values()].flatMap((s) => [...s]),
    ...idsOf(profile.skills.flatMap((g) => g.items)),
    ...idsOf(profile.education.projects.flatMap((p) => p.stack)),
    ...idsOf(profile.engagements.flatMap((e) => e.frameworks?.options ?? [])),
  ]);
  for (const id of neverClaim) global.delete(id);

  const allowedNumbers = new Set<string>(profileRaw.match(/\d+(?:\.\d+)?/g) ?? []);
  for (let i = 0; i <= 10; i++) allowedNumbers.add(String(i));
  const total = totalYears(profile, opts.now);
  allowedNumbers.add(String(total));

  const eligibility = answers.eligibility as Record<string, any>;
  const loc = (eligibility?.location ?? {}) as Record<string, unknown>;
  const relocate = isYes((eligibility?.willing_to_relocate as Record<string, unknown> | undefined)?.prague_or_brno);

  const families = new Map<RoleFamily, Family>();
  for (const [id, f] of Object.entries(profile.positioning.families)) {
    if (!(ROLE_FAMILIES as readonly string[]).includes(id)) throw new Error(`positioning.families: unknown family "${id}" (use ${ROLE_FAMILIES.join(', ')})`);
    families.set(id as RoleFamily, f);
  }
  if (!families.has('fullstack')) {
    families.set('fullstack', { headline: profile.person.headline.split('·')[0].trim(), angle: profile.positioning.default, titles: [], exclude: [] });
  }

  return {
    profile, answers, profileRaw, now: opts.now, engagements, bullets, scopes,
    global, academic, personalOnly, neverClaim, allowedNumbers,
    skillItems: new Set(profile.skills.flatMap((g) => g.items.map((i) => i.toLowerCase()))),
    totalYears: total, maxGapMonths: opts.maxGapMonths,
    location: { commuteCities: Array.isArray(loc.commute_ok) ? (loc.commute_ok as unknown[]).map(String) : [], remote: isYes(loc.remote), relocate },
    families,
  };
}

export const FRAMEWORK_SLOT = '{framework}';

/** The frameworks an engagement's {framework} slot stands for on this vacancy: the options it names, else the default. */
export function frameworksFor(e: Engagement, wanted: Set<string>): string[] {
  if (!e.frameworks) return [];
  const named = e.frameworks.options.filter((o) => [...idsOf([o])].some((id) => wanted.has(id)));
  return named.length ? named : e.frameworks.default;
}

/**
 * The fact base as one vacancy sees it: {framework} filled in (tagline, context, bullets) and those frameworks added to
 * the engagement's stack, so validation and the rendered CV treat "NestJS at Yolo" like any other stack item.
 */
export function forVacancy(k: Knowledge, wanted: Set<string>): Knowledge {
  if (!k.profile.engagements.some((e) => e.frameworks)) return k;
  const engagements = k.profile.engagements.map((e) => {
    const picked = frameworksFor(e, wanted);
    if (!picked.length) return e;
    const fill = (t: string): string => t.replaceAll(FRAMEWORK_SLOT, picked.join(', '));
    return {
      ...e, tagline: fill(e.tagline), context: fill(e.context), stack: [...e.stack, ...picked],
      bullets: e.bullets.map((b) => ({ ...b, text: fill(b.text) })),
    };
  });
  const byId = new Map(engagements.map((e) => [e.id, e]));
  const bullets = new Map(engagements.flatMap((e) => e.bullets.map((b) => [b.id, { engagement: e.id, text: b.text }] as const)));
  const scopes = new Map(engagements.map((e) => [e.id, idsOf(e.stack)] as const));
  return { ...k, profile: { ...k.profile, engagements }, engagements: byId, bullets, scopes };
}
