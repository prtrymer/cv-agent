import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { checkProse } from '../pipeline/validate.js';
import { sha256 } from '../util/hash.js';
import { isChoice, toField, type Answer, type Facts } from './answers.js';
import type { Field } from './scan.js';

/** Questions the model may take: prose and choices. Files, consent boxes and dates stay with rules or with you. */
export const forModel = (f: Field): boolean =>
  f.kind === 'textarea' || f.kind === 'text' || f.kind === 'number' || (isChoice(f) && f.kind !== 'checkbox');

/**
 * One call for all remaining questions. Each answer is grounded (choices must be real options, prose passes the
 * CV's fact checks) or comes back as "unknown", which means: ask the person, never guess.
 */
export async function modelAnswers(ctx: Ctx, fields: Field[], facts: Facts, vacancyText: string, maxChars: number): Promise<Map<string, Answer>> {
  const out = new Map<string, Answer>();
  const qs = fields.filter(forModel);
  if (!qs.length) return out;
  const ids = qs.map((f) => f.id) as [string, ...string[]];
  const schema = z.object({
    answers: z.array(z.object({
      id: z.enum(ids),
      value: z.union([z.string().max(maxChars), z.array(z.string().max(200)).max(20)]).nullable(),
      basis: z.enum(['fact', 'unknown']),
    }).strict()),
  }).strict();
  const byId = new Map(qs.map((f) => [f.id, f]));
  const questions = qs.map((f) => JSON.stringify({ id: f.id, question: f.label, kind: f.kind, required: f.required, ...(f.options.length ? { options: f.options } : {}) }));
  const formId = sha256(`${facts.vacancy.url}\n${questions.join('\n')}`).slice(0, 16);

  const { data } = await ctx.llm.call<z.infer<typeof schema>>({
    stage: 'answer', vacancyId: `form:${formId}`, toolName: 'submit_answers',
    toolDescription: 'Return answers to the application-form questions.',
    schema, system: ctx.prompts.answer.text,
    promptVersion: ctx.prompts.answer.version, promptHash: ctx.prompts.answer.hash,
    user: [
      `<form id="${formId}" role="${facts.vacancy.title}" company="${facts.vacancy.company ?? 'unknown'}">`,
      ...questions, '</form>',
      `<cover_letter>\n${facts.files.letterText.trim()}\n</cover_letter>`,
      `<vacancy>\n${vacancyText}\n</vacancy>`,
    ].join('\n'),
    semanticCheck: (d) => d.answers.flatMap((a) => {
      const f = byId.get(a.id);
      if (!f || a.value === null || a.basis === 'unknown') return [];
      if (isChoice(f)) {
        const values = Array.isArray(a.value) ? a.value : [a.value];
        return values.filter((v) => !f.options.includes(v)).map((v) => `${a.id}: "${v}" is not one of its options ${JSON.stringify(f.options)}`);
      }
      return typeof a.value === 'string' ? checkProse(a.value, a.id, ctx.k) : [`${a.id}: a text question takes one string`];
    }),
  });

  for (const a of data.answers) {
    const f = byId.get(a.id);
    if (!f || a.value === null || a.basis === 'unknown') continue;
    if (!isChoice(f) && typeof a.value === 'string' && checkProse(a.value, a.id, ctx.k).length) continue; // failed grounding twice: ask instead
    const ans = toField(f, a.value, 'model');
    if (ans) out.set(f.id, ans);
  }
  return out;
}
