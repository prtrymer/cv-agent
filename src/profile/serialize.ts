import YAML from 'yaml';
import { durationMonths, durationText, yearsByTech, type Knowledge } from './profile.js';

/** Technologies whose commercial years triage compares against a posting's "N+ years of X". */
const YEARS_FOR = ['TypeScript', 'JavaScript', 'React', 'Angular', 'Next.js', 'Node.js', 'NestJS', 'Java', 'Spring', 'PostgreSQL', 'Redis', 'Elixir', 'Python', 'AWS', 'Docker'];

/** Compact profile for the triage prompt: enough to judge fit, nothing more (it is sent on every call). */
export function triageProfileText(k: Knowledge): string {
  const p = k.profile;
  const cities = k.location.commuteCities.join(', ') || 'none';
  return [
    `${p.person.name} — ${p.person.headline}`,
    `Total commercial experience: ${k.totalYears} years (since ${p.person.career_start}). Positioning: ${p.positioning.default}.`,
    `Commercial years by technology (merged date ranges, rounded down to 0.5): ${yearsByTech(p, YEARS_FOR, k.now).map(([t, y]) => `${t} ${y}`).join(', ')}.`,
    `Location: lives in ${p.person.location}; authorized to work in Czechia; remote OK; hybrid or on-site only in ${cities}; ${k.location.relocate ? 'open to relocating there' : 'not relocating, commutes'}.`,
    `Languages: ${p.languages.map((l) => `${l.name} (${l.level})`).join(', ')}.`,
    'Engagements (id | company | dates | stack):',
    ...p.engagements.map((e) => `- ${e.id} | ${e.company} | ${e.start} – ${e.end} | ${e.stack.join(', ')}${e.frameworks ? `; its TypeScript services ran on ${e.frameworks.options.join(', ')} — whichever of these the vacancy asks for counts as matched here` : ''}`),
    `Education: ${p.education.degree} (${p.education.start}–${p.education.end}); projects: ${p.education.projects.map((pr) => `${pr.title} [${pr.stack.join(', ')}]${pr.academic_only.length ? ' (academic only)' : ''}`).join('; ')}.`,
    `Skills: ${[...new Set(p.skills.flatMap((g) => g.items))].join(', ')}.`,
    `Not in the profile — never counts as matched: ${p.guardrails.never_claim.join(', ')}.`,
  ].join('\n');
}

/** Full fact base for the tailoring prompt: the only material the model may draw on. */
export function tailorFactbaseText(k: Knowledge): string {
  const p = k.profile;
  const out: string[] = [
    `TOTAL YEARS: ${k.totalYears} (since ${p.person.career_start})`,
    `MASTER SUMMARY: ${p.summary.master.trim()}`,
    '',
    'ENGAGEMENTS (chronological order is fixed by code)',
  ];
  for (const e of p.engagements) {
    out.push(`## ${e.id} — ${e.company}${e.product ? ` (${e.product})` : ''} · ${e.start} – ${e.end} · duration: ${durationText(durationMonths(e, k.now))}${e.omit_ok ? ' · omit_ok' : ''}`);
    if (e.context.trim()) out.push(`context: ${e.context.trim()}`);
    out.push(`stack: ${e.stack.join(', ')}`);
    if (e.frameworks) out.push(`{framework}: its TypeScript services ran on ${e.frameworks.options.join(', ')}. Write {framework} as the framework(s) <task> names for ${e.id} (without it: ${e.frameworks.default.join(', ')}) — never the braces themselves.`);
    out.push('bullets:');
    for (const b of e.bullets) out.push(`- ${b.id} [${b.tags.join(', ')}]: ${b.text}`);
    out.push('');
  }
  out.push('EDUCATION', `${p.education.degree}, ${p.education.school} (${p.education.start}–${p.education.end})`);
  for (const pr of p.education.projects) out.push(`- ${pr.id}${pr.academic_only.length ? ' (academic only)' : ''}: ${pr.title} — ${pr.text.trim()}`);
  out.push('', `AI SECTION (rendered when include_ai_section is true): ${p.ai_agent_section.master.trim()}`, '', 'SKILLS');
  for (const g of p.skills) out.push(`- ${g.group}: ${g.items.join(', ')}`);
  out.push(
    '',
    `LANGUAGES: ${p.languages.map((l) => `${l.name} (${l.level})`).join(', ')}`,
    `NEVER MENTION: ${p.guardrails.never_mention.join('; ')}`,
    `NEVER CLAIM: ${p.guardrails.never_claim.join(', ')}`,
    `PERSONAL PROJECTS ONLY: ${p.guardrails.personal_only.join(', ')}`,
  );
  return out.join('\n');
}

/** Positioning per role family for the tailoring prompt; the <task> block names the one to use. */
export function familiesText(k: Knowledge): string {
  return [...k.families].map(([id, f]) => `- ${id}: headline "${f.headline}" — ${f.angle}${f.exclude.length ? `. Never mention: ${f.exclude.join(', ')} — skip bullets, projects and summary phrases about them` : ''}`).join('\n');
}

/**
 * answers.yaml for the form-answer prompt, minus contact details (code fills those, so phone numbers and email
 * never reach the model) and minus the salary job's internals (salary questions are asked in person for now).
 */
export function answersText(k: Knowledge): string {
  const a = k.answers as Record<string, any>;
  const { salary_expectation: _salary, ...logistics } = (a.logistics ?? {}) as Record<string, unknown>;
  return YAML.stringify({
    eligibility: a.eligibility, logistics, current_role: a.current_role, consent: a.consent, demographics: a.demographics,
    languages: k.profile.languages, total_years: k.totalYears,
  }).trim();
}
