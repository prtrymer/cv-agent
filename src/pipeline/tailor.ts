import { z } from 'zod';
import type { Knowledge } from '../profile/profile.js';
import type { Plan } from './validate.js';

/** Built per profile so engagement and bullet ids are enums in the JSON schema: the model can only pick what exists. */
export function makePlanSchema(k: Knowledge): z.ZodType<Plan> {
  const engagementIds = [...k.engagements.keys()] as [string, ...string[]];
  const bulletIds = [...k.bullets.keys()] as [string, ...string[]];
  return z.object({
    headline: z.string().min(10).max(90),
    summary: z.string().min(150).max(700),
    entries: z.array(z.object({
      engagement: z.enum(engagementIds),
      bullets: z.array(z.object({
        id: z.enum(bulletIds),
        text: z.string().max(360).nullable(),
      }).strict()).min(1).max(4),
    }).strict()).min(2).max(6),
    omit: z.array(z.enum(engagementIds)).max(engagementIds.length),
    skills_first: z.array(z.string().max(60)).max(30), // ordering only: extras are ignored, never worth a retry
    include_ai_section: z.boolean(),
    cover_letter: z.object({
      intro: z.string().min(30).max(400),
      snapshot: z.string().min(60).max(800),
      before: z.string().max(800).nullable(),
      proof: z.string().max(600).nullable(),
    }).strict(),
  }).strict();
}

/**
 * A model sometimes garbles one key of an otherwise fine object ("englets" for "bullets", seen in a real run, twice in
 * a row). When exactly one expected key is missing and exactly one unknown key is present, the unknown one is it.
 */
function fixKeys(raw: unknown, expected: readonly string[]): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !(key in o));
  if (unknown.length !== 1 || missing.length !== 1) return raw;
  const { [unknown[0]!]: value, ...rest } = o;
  return { ...rest, [missing[0]!]: value };
}

const PLAN_KEYS = ['headline', 'summary', 'entries', 'omit', 'skills_first', 'include_ai_section', 'cover_letter'] as const;

/**
 * Free fixes before validation, each of which used to cost a repair round: a summary over the limit loses trailing
 * whole sentences (seen twice in a real run), and a single misspelt key is renamed to the one that is missing.
 */
export function coercePlan(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const p = { ...(fixKeys(raw, PLAN_KEYS) as Record<string, unknown>) };
  if (Array.isArray(p.entries)) {
    p.entries = p.entries.map((entry) => {
      const e = fixKeys(entry, ['engagement', 'bullets']);
      if (!e || typeof e !== 'object' || Array.isArray(e)) return e;
      const bullets = (e as Record<string, unknown>).bullets;
      return Array.isArray(bullets) ? { ...e, bullets: bullets.map((b) => fixKeys(b, ['id', 'text'])) } : e;
    });
  }
  p.cover_letter = fixKeys(p.cover_letter, ['intro', 'snapshot', 'before', 'proof']);
  if (typeof p.summary === 'string' && p.summary.length > 700) {
    const parts = p.summary.split(/(?<=[.!?])\s+/);
    while (parts.length > 1 && parts.join(' ').length > 700) parts.pop();
    p.summary = parts.join(' ');
  }
  return p;
}
