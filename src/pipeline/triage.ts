import { z } from 'zod';
import type { Config } from '../config.js';
import type { VacancyRow } from '../store/db.js';
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

const RANK = { reject: 0, borderline: 1, apply: 2 } as const;

/** The model scores; the code decides, and always takes the more conservative of the two. */
export function decide(t: Triage, injection: string[], p: Config['pipeline']): { status: Status; reason: string } {
  if (t.injection_suspected || injection.length > 0) {
    return { status: 'needs_review', reason: `possible prompt injection in the posting${injection.length ? ` (${injection[0]})` : ''}` };
  }
  if (p.minSeniority !== 'junior' && t.seniority === 'junior') return { status: 'rejected', reason: 'junior role (pipeline.minSeniority)' };
  if (!(p.roleFamilies as string[]).includes(t.role_family)) return { status: 'rejected', reason: `role family "${t.role_family}" is not in pipeline.roleFamilies` };
  if (!t.location_ok) return { status: 'rejected', reason: `location/eligibility${t.hard_blockers.length ? `: ${t.hard_blockers[0]}` : ''}` };
  const byScore = t.score >= p.applyThreshold ? 'apply' : t.score >= p.borderlineMin ? 'borderline' : 'reject';
  const final = RANK[byScore] <= RANK[t.decision] ? byScore : t.decision;
  if (final === 'apply') return { status: 'tailor_pending', reason: `score ${t.score}` };
  if (final === 'borderline') return { status: 'borderline', reason: `score ${t.score}${t.hard_blockers.length ? `; ${t.hard_blockers.join('; ')}` : ''}` };
  return { status: 'rejected', reason: t.hard_blockers.join('; ') || `score ${t.score}` };
}
