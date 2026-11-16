import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildKnowledge, forVacancy, loadAnswers, loadProfile, resolveSkill, titleFor, yearsWithTech, type Knowledge } from '../src/profile/profile.js';
import { validatePlan, type Plan } from '../src/pipeline/validate.js';
import { detectTech } from '../src/profile/lexicon.js';
import { decide, type Triage } from '../src/pipeline/triage.js';
import { loadConfig } from '../src/config.js';
import { cvFamily, postingWants } from '../src/pipeline/run.js';

const clone = (p: Plan): Plan => JSON.parse(JSON.stringify(p));
const UK_PITCH = 'Вітаю! Я fullstack-інженер із 3,5 роками досвіду в TypeScript, React і NestJS. Створив із нуля гру винагород для програми лояльності на NestJS, PostgreSQL і Redis з оновленнями в реальному часі через WebSocket. Буду радий поспілкуватися!';
let k: Knowledge;
let good: Plan;

beforeAll(() => {
  const profile = loadProfile('fixtures/profile/profile.yaml');
  k = buildKnowledge(profile.data, loadAnswers('fixtures/profile/answers.yaml'), profile.raw, { now: new Date('2026-09-22'), maxGapMonths: 2 });
  good = JSON.parse(fs.readFileSync('fixtures/llm/dou_900001.tailor.json', 'utf8')) as Plan;
});

describe('plan validation', () => {
  it('accepts the fixture plan', () => {
    expect(validatePlan(good, k, 'en', 'fullstack')).toEqual([]);
  });
  it('holds the recruiter message to product experience, the facts and its length limits', () => {
    const pitch = { noteMaxChars: 300, messageMaxChars: 700, skipEngagements: ['campus'] };
    const errs = (edit: (p: Plan) => void): string => { const p = clone(good); edit(p); return validatePlan(p, k, 'en', 'fullstack', new Set(), pitch).join(' | '); };
    expect(errs(() => {})).toBe('');
    expect(errs((p) => { delete p.recruiter_message; })).toMatch(/recruiter_message: missing/);
    expect(errs((p) => { p.recruiter_message!.note += ' For my thesis I built a trading system on Kafka.'; })).toMatch(/recruiter_message\.note: product experience only/);
    expect(errs((p) => { p.recruiter_message!.message += ' I also built a student platform still in production.'; })).toMatch(/product experience only/);
    expect(errs((p) => { p.recruiter_message!.message += ' Before that I shipped Campus Advisor.'; })).toMatch(/leave campus .* out/);
    expect(errs((p) => { p.recruiter_message!.note = `${p.recruiter_message!.note} ${'More of the same.'.repeat(3)}`; })).toMatch(/recruiter_message\.note: \d+ characters — the limit is 300/);
    expect(errs((p) => { p.recruiter_message!.message += ' I have 8 years of experience with Kubernetes.'; })).toMatch(/claims 8 years/);
    expect(errs((p) => { p.recruiter_message!.message += ' I have no commercial experience with Go.'; })).toMatch(/positive-only/);
    // A plan stored before recruiter messages existed is still valid where none is asked for (old packs).
    expect(validatePlan({ ...clone(good), recruiter_message: undefined }, k, 'en', 'fullstack')).toEqual([]);
  });
  it('trims a recruiter message over its limit to whole sentences before it is checked', async () => {
    const { coercePlan } = await import('../src/pipeline/tailor.js');
    const pitch = { noteMaxChars: 60, messageMaxChars: 700, skipEngagements: [] };
    const fixed = coercePlan({ recruiter_message: { note: 'Hi! I build products end to end. This sentence does not fit any more.', mesage: 'm' } }, pitch) as { recruiter_message: Record<string, string> };
    expect(fixed.recruiter_message).toEqual({ note: 'Hi! I build products end to end.', message: 'm' });
    // The closing line is added by code, so the model gets that much less room in the message.
    const { pitchRules } = await import('../src/pipeline/tailor.js');
    expect(pitchRules({ noteMaxChars: 300, messageMaxChars: 700, skipEngagements: [], closing: { en: 'Happy to talk!', uk: 'Буду радий!' } }).messageMaxChars).toBe(685);
  });
  it('rejects a bullet borrowed from another engagement', () => {
    const p = clone(good);
    p.entries[0].bullets[0].id = 'rw.game';
    expect(validatePlan(p, k, 'en', 'fullstack').join(' ')).toMatch(/does not belong to retail/);
  });
  it('requires the headline of the role family it was built for', () => {
    expect(validatePlan(good, k, 'en', 'java').join(' ')).toMatch(/start with "Java Developer · "/);
    const p = clone(good);
    p.headline = 'Java Developer · Java / Spring Boot / PostgreSQL';
    expect(validatePlan(p, k, 'en', 'java').filter((e) => e.startsWith('headline'))).toEqual([]);
  });
  it('builds a Java CV from the Java engagements only, the group dates covering the rest', () => {
    const p = clone(good);
    p.headline = 'Java Developer · Java / Spring Boot / PostgreSQL';
    p.summary = 'Java Developer with 3+ years of Java and Spring Boot, building validated backends for a public permits system.';
    p.entries = [
      { engagement: 'permits', bullets: [{ id: 'pm.application-validation', text: null }] },
      { engagement: 'stats', bullets: [{ id: 'stats.tests', text: null }] },
    ];
    expect(validatePlan(p, k, 'en', 'java').filter((e) => /^(entries|timeline|summary)/.test(e))).toEqual([]);
    p.entries.push({ engagement: 'rewards', bullets: [{ id: 'rw.infra', text: null }] });
    expect(validatePlan(p, k, 'en', 'java').join(' ')).toMatch(/shows only permits, stats — leave "rewards" out/);
    expect(yearsWithTech(k.profile, 'Java', k.now)).toBe(3);
  });
  it('shows Java work next to React on a java-fullstack CV, which the fullstack family hides', () => {
    const p = clone(good);
    p.entries.push({ engagement: 'permits', bullets: [{ id: 'pm.application-validation', text: null }] });
    expect(validatePlan(p, k, 'en', 'fullstack').join(' ')).toMatch(/pm\.application-validation/);
    expect(validatePlan(p, k, 'en', 'java-fullstack').filter((e) => e.includes('pm.application-validation'))).toEqual([]);
    expect(titleFor(k.engagements.get('permits')!, k.families.get('java-fullstack'))).toBe('Full Stack Engineer');
  });
  it('lets a posting that allows Java keep the Java/Spring bullets on a fullstack CV', async () => {
    const { postingWants } = await import('../src/pipeline/run.js');
    const p = clone(good);
    p.entries.push({ engagement: 'permits', bullets: [{ id: 'pm.application-validation', text: null }] });
    const wanted = postingWants('Software Engineer', 'High proficiency in any cloud-oriented backend language (Go, TypeScript, Java, Python etc.)');
    expect([...wanted]).toEqual(expect.arrayContaining(['java', 'spring']));
    expect(validatePlan(p, k, 'en', 'fullstack', wanted).filter((e) => e.includes('pm.application-validation'))).toEqual([]);
    expect(postingWants('Frontend Engineer', 'React and TypeScript').has('spring')).toBe(false);
  });
  it('prints the job title the family prefers, from the titles each engagement allows', () => {
    const f = (id: 'java' | 'frontend' | 'fullstack') => k.families.get(id);
    expect(titleFor(k.engagements.get('permits')!, f('java'))).toBe('Java Developer');
    expect(titleFor(k.engagements.get('rewards')!, f('java'))).toBe('Backend Engineer');
    expect(titleFor(k.engagements.get('retail')!, f('frontend'))).toBe('Frontend Engineer');
    expect(titleFor(k.engagements.get('campus')!, f('frontend'))).toBe('Backend Engineer');
  });
  it('rejects a technology that is not in that engagement stack', () => {
    const p = clone(good);
    p.entries[0].bullets[0].text = 'The team needed a new service — built it in Kotlin with Spring Boot, shipped in a week.';
    expect(validatePlan(p, k, 'en', 'fullstack').join(' ')).toMatch(/Kotlin/);
  });
  it('rejects invented numbers and overstated years', () => {
    const p = clone(good);
    p.summary = p.summary.replace('3.5 years', '7 years').replace('production web products', 'production web products for 42 clients');
    const errs = validatePlan(p, k, 'en', 'fullstack').join(' ');
    expect(errs).toMatch(/claims 7 years/);
    expect(errs).toMatch(/"42" is not in the fact base/);
  });
  it('rejects square brackets left from the [duration] mask', () => {
    const p = clone(good);
    p.cover_letter.snapshot = p.cover_letter.snapshot.replace(/^Quick snapshot: /, 'Quick snapshot: [duration] and [one year] of it — ');
    const errs = validatePlan(p, k, 'en', 'fullstack').filter((e) => e.startsWith('no square brackets'));
    expect(errs).toEqual([
      'no square brackets: write [duration] as plain text — [duration] in the voice sample is a placeholder',
      'no square brackets: write [one year] as plain text — [duration] in the voice sample is a placeholder',
    ]);
  });
  it('rejects the word tailored and any gap talk', () => {
    const p = clone(good);
    p.cover_letter.proof = 'I have no commercial experience with Kubernetes, but this CV is tailored for the role.';
    const errs = validatePlan(p, k, 'en', 'fullstack').join(' ');
    expect(errs).toMatch(/tailored/);
    expect(errs).toMatch(/positive-only/);
  });
  it('rejects a timeline gap created by omitting too much', () => {
    const p = clone(good);
    p.entries = p.entries.filter((e) => e.engagement === 'retail' || e.engagement === 'campus');
    expect(validatePlan(p, k, 'en', 'fullstack').join(' ')).toMatch(/gap/);
  });
  it('rejects thesis-only technology used as commercial experience', () => {
    const p = clone(good);
    p.summary = `${p.summary} I run Kafka pipelines in production every day.`;
    expect(validatePlan(p, k, 'en', 'fullstack').join(' ')).toMatch(/Kafka/);
  });
  it('rejects a cover letter that writes its own greeting or mentions attachments', () => {
    const p = clone(good);
    p.cover_letter.intro = 'Hi! I am Alex and my CV is attached.';
    const errs = validatePlan(p, k, 'en', 'fullstack').join(' ');
    expect(errs).toMatch(/greeting is added by code/);
    expect(errs).toMatch(/attachments/);
  });
});

describe('which CV a vacancy gets', () => {
  const fams = new Set(['fullstack', 'frontend', 'backend', 'java', 'java-fullstack', 'devops', 'fde']);
  it('keeps an in-scope family, and gives an "other" one the Java CV only when the posting names Java without JS/TS', () => {
    expect(cvFamily('backend', new Set(['java']), fams)).toBe('backend');
    const javaPolyglot = postingWants('Senior Software Engineer', 'Able to write complex code in multiple programming languages such as Java, Python, and C++.');
    expect(cvFamily('other', javaPolyglot, fams)).toBe('java');
    expect(cvFamily('other', postingWants('Software Engineer', 'Java and TypeScript services'), fams)).toBe('fullstack');
    expect(cvFamily('other', postingWants('Software Engineer', 'JavaScript and Python'), fams)).toBe('fullstack');
    expect(cvFamily(undefined, new Set(), fams)).toBe('fullstack');
  });
});

describe('role family scope', () => {
  const t: Triage = JSON.parse(fs.readFileSync('fixtures/llm/dou_900001.triage.json', 'utf8'));
  const p = loadConfig('config/agent.yaml').pipeline;
  it('decides on the score alone: no borderline, and a family the model called "other" is no reject by itself', () => {
    for (const role_family of ['fullstack', 'frontend', 'backend', 'java', 'java-fullstack', 'devops', 'fde', 'other'] as const) expect(decide({ ...t, role_family }, [], p).status).toBe('tailor_pending');
    expect(decide({ ...t, score: 52, decision: 'reject' }, [], p)).toEqual({ status: 'tailor_pending', reason: 'score 52' });
    expect(decide({ ...t, score: 45, role_family: 'other', hard_blockers: [] }, [], p)).toEqual({ status: 'rejected', reason: 'score 45 (role family "other")' });
  });
  it('rejects on location only for a place-shaped blocker (the model used location_ok for years and skills)', () => {
    expect(decide({ ...t, score: 55, location_ok: false, hard_blockers: ['5+ years Node.js required (candidate has 3.5)'] }, [], p).status).toBe('tailor_pending');
    expect(decide({ ...t, score: 55, location_ok: false, hard_blockers: ['no Three.js/WebGL experience'] }, [], p).status).toBe('tailor_pending');
    expect(decide({ ...t, score: 72, location_ok: false, hard_blockers: ['on-site in Lviv'] }, [], p)).toEqual({ status: 'rejected', reason: 'location/eligibility: on-site in Lviv' });
    // An office in a commute city is no blocker, whatever the model says (2026-11-07).
    const prague = ['on-site in Prague office (candidate commutes to Prague, but role is primarily in-office)', '5+ years in Java/Python'];
    expect(decide({ ...t, score: 58, location_ok: false, hard_blockers: prague }, [], p, undefined, ['Prague']).status).toBe('tailor_pending');
    expect(decide({ ...t, score: 58, location_ok: false, hard_blockers: ['hybrid in Praha'] }, [], p, undefined, ['prague']).status).toBe('tailor_pending');
    // "in-office" is the same thing as "on-site" (2026-11-13): a low score is then rejected for the real reason.
    const inOffice = ['primary development in Go', 'in-office in Prague required (candidate commutes only to Brno/Prague — Prague is a commute city, so not a blocke'];
    expect(decide({ ...t, score: 58, location_ok: false, hard_blockers: inOffice }, [], p, undefined, ['Brno', 'Prague']).status).toBe('tailor_pending');
    expect(decide({ ...t, score: 48, role_family: 'other', location_ok: false, hard_blockers: inOffice }, [], p, undefined, ['Brno', 'Prague'])).toEqual({ status: 'rejected', reason: 'primary development in Go (role family "other")' });
    expect(decide({ ...t, score: 58, location_ok: false, hard_blockers: ['in-office in Lviv required'] }, [], p, undefined, ['Prague']).status).toBe('rejected');
    expect(decide({ ...t, score: 58, location_ok: false, hard_blockers: ['on-site in Lviv'] }, [], p, undefined, ['Prague']).status).toBe('rejected');
    expect(decide({ ...t, score: 58, location_ok: false, hard_blockers: ['on-site in Prague, Czech citizenship required'] }, [], p, undefined, ['Prague']).status).toBe('rejected');
    expect(decide({ ...t, score: 72, location_ok: false, hard_blockers: ['Ukrainian citizenship required'] }, [], p).status).toBe('rejected');
    expect(decide({ ...t, score: 30, location_ok: true, hard_blockers: ['5+ years Java', '8+ years overall'] }, [], p).reason).toBe('8+ years overall');
  });
  it('never rejects an employer you will ask about working from abroad on location', () => {
    const q = { ...p, locationAskCompanies: ['Example Bank'] };
    const blocked = { ...t, score: 58, location_ok: false, hard_blockers: ['remote restricted to Ukraine'] };
    const listing = { location: 'Київ, віддалено', text: 'official employment' };
    expect(decide(blocked, [], q, { ...listing, company: 'Example Bank' }).status).toBe('tailor_pending');
    expect(decide(blocked, [], q, { ...listing, company: 'Other Bank' }).status).toBe('rejected');
    expect(decide({ ...blocked, score: 40 }, [], q, { ...listing, company: 'Example Bank' }).status).toBe('rejected');
  });
  it('ignores an on-site blocker when the listing says remote and only offers the office', () => {
    const blocked = { ...t, score: 58, location_ok: false, hard_blockers: ['on-site/hybrid in Kyiv, Ukraine'] };
    const offered = { location: 'Київ, віддалено', text: '* Comfortable working conditions: the possibility of a hybrid work format, offices with shelters' };
    expect(decide(blocked, [], p, offered).status).toBe('tailor_pending');
    expect(decide(blocked, [], p).status).toBe('rejected');
    expect(decide(blocked, [], p, { ...offered, location: 'Київ' }).status).toBe('rejected');
    expect(decide(blocked, [], p, { ...offered, text: '* A hybrid working format with our office in central Lviv' }).status).toBe('rejected');
    expect(decide({ ...blocked, hard_blockers: ['on-site in Kyiv or remote restricted to Ukraine'] }, [], p, offered).status).toBe('rejected');
    expect(decide({ ...blocked, hard_blockers: ['remote restricted to Ukraine'] }, [], p, offered).status).toBe('rejected');
  });
  it('ignores the offices when the listing also offers remote anywhere in the EU or Europe (2026-11-11)', () => {
    const euRemote = { location: null, text: 'Work Setup: Hybrid in Dubai or Madrid, remote anywhere in the EU. Or we offer relocation support to Dubai or Madrid, if preferred.' };
    const blocked = { ...t, score: 58, location_ok: false, hard_blockers: ['hybrid on-site in Dubai or Madrid'] };
    expect(decide(blocked, [], p, euRemote).status).toBe('tailor_pending');
    expect(decide({ ...blocked, hard_blockers: [] }, [], p, euRemote).status).toBe('tailor_pending');
    expect(decide(blocked, [], p, { ...euRemote, text: 'Hybrid in Dubai or Madrid.' }).status).toBe('rejected');
    expect(decide({ ...blocked, hard_blockers: ['hybrid in Madrid', 'EU citizenship required'] }, [], p, euRemote).status).toBe('rejected');
    for (const text of ['Fully remote within Europe (CET ±2h).', 'EU-remote, or our Berlin office', 'Remote from the EEA']) {
      expect(decide(blocked, [], p, { location: null, text }).status, text).toBe('tailor_pending');
    }
    for (const text of ['Remote in Western Europe only', 'Remote from Spain; hybrid in Madrid', 'Remote across the EU is not possible, on-site only']) {
      expect(decide(blocked, [], p, { location: null, text }).status, text).toBe('rejected');
    }
  });
});

describe('durations and skill names (found in the first live run)', () => {
  it('rejects a duration copied from the voice sample for the engagement the sentence is about', () => {
    const p = clone(good);
    p.cover_letter.before = 'Before that: a year on an Elixir microservice platform (Phoenix, Ecto, OTP), so new stacks are routine.';
    expect(validatePlan(p, k, 'en', 'fullstack').join(' ')).toMatch(/"a year" doesn't match the fact base \(metrics lasted 1 year 7 months\)/);
    p.cover_letter.before = 'Before that: one and a half years on an Elixir microservice platform (Phoenix, Ecto, OTP), so new stacks are routine.';
    expect(validatePlan(p, k, 'en', 'fullstack')).toEqual([]);
    p.cover_letter.before = 'Before that: a year and a half on an Elixir microservice platform (Phoenix, Ecto, OTP), so new stacks are routine.';
    expect(validatePlan(p, k, 'en', 'fullstack')).toEqual([]);
  });
  it('accepts true durations and the total, and rejects invented ones', () => {
    const p = clone(good);
    p.cover_letter.snapshot = 'Quick snapshot: a year building a loyalty rewards game end to end on NestJS, React and PostgreSQL, with real-time updates over WebSocket.';
    expect(validatePlan(p, k, 'en', 'fullstack')).toEqual([]);
    p.cover_letter.snapshot = 'Quick snapshot: five years building reward games end to end on NestJS, React and PostgreSQL, with real-time updates over WebSocket.';
    expect(validatePlan(p, k, 'en', 'fullstack').join(' ')).toMatch(/"five years" doesn't match/);
  });
  it('maps near-miss skill names instead of failing the plan', () => {
    const items = k.profile.skills.flatMap((g) => g.items);
    expect(resolveSkill('WebSockets', items)).toBe('WebSocket');
    expect(resolveSkill('AWS', items)).toBe('AWS (S3, Lambda, EKS, DynamoDB)');
    expect(resolveSkill('Redux', items)).toBe('Redux/RTK');
    expect(resolveSkill('AI/LLM integration', items)).toBeNull();
    const p = clone(good);
    p.skills_first = ['WebSockets', 'AWS', 'AI/LLM integration'];
    expect(validatePlan(p, k, 'en', 'fullstack')).toEqual([]);
  });
});

describe('durations in a sentence about two engagements (second live run)', () => {
  it('checks each duration against the engagement it describes', () => {
    const p = clone(good);
    p.cover_letter.snapshot = 'Quick snapshot: five months on a multi-market grocery marketplace, migrating a large React codebase with Claude Code and Codex, and a year of end-to-end ownership on a loyalty rewards game built from scratch in NestJS, React and PostgreSQL.';
    expect(validatePlan(p, k, 'en', 'fullstack')).toEqual([]);
    p.cover_letter.snapshot = 'Quick snapshot: a year on a multi-market grocery marketplace, migrating a large React codebase with Claude Code and Codex, and five months on a loyalty rewards game built from scratch in NestJS, React and PostgreSQL.';
    const errs = validatePlan(p, k, 'en', 'fullstack').join(' ');
    expect(errs).toMatch(/"a year" doesn't match the fact base \(retail lasted 5 months\)/);
    expect(errs).toMatch(/"five months" doesn't match the fact base \(rewards lasted 1 year\)/);
  });
});

describe('triage output tidying (first real run)', () => {
  it('fixes shape-only mistakes for free', async () => {
    const { coerceTriage, TriageSchema } = await import('../src/pipeline/triage.js');
    const t = JSON.parse(fs.readFileSync('fixtures/llm/dou_900001.triage.json', 'utf8'));
    const messy = { ...t, salary: '3500-4500 USD', matched_requirements: 'TypeScript and NestJS', hard_blockers: ['a', 'b', 'c', 'd', 'e', 'f'], lead_with: ['retail', 'rewards', 'metrics', 'campus'] };
    expect(TriageSchema.safeParse(messy).success).toBe(false);
    const fixed = TriageSchema.parse(coerceTriage(messy));
    expect(fixed).toMatchObject({ salary: null, matched_requirements: ['TypeScript and NestJS'], hard_blockers: ['a', 'b', 'c', 'd', 'e'], lead_with: ['retail', 'rewards', 'metrics'] });
    expect(TriageSchema.parse(coerceTriage({ ...t, role_family: 'Java_Fullstack' })).role_family).toBe('java-fullstack');
  });
});

describe('Ukrainian letters (first real packs)', () => {
  it('checks Ukrainian durations and openers', () => {
    const p = clone(good);
    p.cover_letter.intro = 'Я — Алекс, fullstack-інженер із 3,5 роками досвіду в TypeScript, React і NestJS, і хочу долучитися до команди Acme iGaming на позиції Full-Stack Developer.';
    p.recruiter_message = { note: UK_PITCH, message: UK_PITCH };
    p.cover_letter.proof = 'Перший проєкт, який я запустив, — студентська платформа на NestJS і Prisma — досі працює в продакшені для ~500 одночасних користувачів.';
    p.cover_letter.snapshot = 'Коротко: рік повної відповідальності за гру винагород на NestJS, React і PostgreSQL, з оновленнями в реальному часі через WebSocket.';
    p.cover_letter.before = 'До цього: рік на Elixir-мікросервісній платформі (Phoenix, Ecto, OTP), тож нові стеки для мене — звична справа.';
    const errs = validatePlan(p, k, 'uk', 'fullstack').join(' ');
    expect(errs).toMatch(/"рік на" doesn't match|"рік" doesn't match/);
    expect(errs).toMatch(/metrics lasted 1 year 7 months/);
    expect(errs).not.toMatch(/snapshot/); // the rewards-game "рік" is true (rewards lasted a year)
    p.cover_letter.before = 'До цього: півтора року на Elixir-мікросервісній платформі (Phoenix, Ecto, OTP), з 2023 року — тож нові стеки для мене звична справа.';
    expect(validatePlan(p, k, 'uk', 'fullstack')).toEqual([]);
    // Years and months together are one duration, not "4 місяці" on their own (false alarms on real packs).
    for (const d of ['1 рік 7 місяців', 'рік і сім місяців', 'рік, 7 місяців']) {
      p.cover_letter.before = `До цього: ${d} на Elixir-мікросервісній платформі (Phoenix, Ecto, OTP).`;
      expect(validatePlan(p, k, 'uk', 'fullstack')).toEqual([]);
    }
    p.cover_letter.before = 'До цього: 2 роки 9 місяців на Elixir-мікросервісній платформі (Phoenix, Ecto, OTP).';
    expect(validatePlan(p, k, 'uk', 'fullstack').join(' ')).toMatch(/"2 роки 9 місяців" doesn't match/);
    p.cover_letter.snapshot = 'Quick snapshot: рік повної відповідальності за гру винагород на NestJS, React і PostgreSQL.';
    expect(validatePlan(p, k, 'uk', 'fullstack').join(' ')).toMatch(/«Коротко:»/);
  });
  it('accepts a month count worked out from the dates, though the number is not in the profile', () => {
    const p = clone(good);
    p.cover_letter.proof = null;
    // Campus Advisor ran 2023-03 – 2024-01: 11 months, a number the profile never writes (false alarm on a real pack).
    p.cover_letter.before = 'Before that: 11 months building a student platform on NestJS and Prisma over PostgreSQL, still in production.';
    expect(validatePlan(p, k, 'en', 'fullstack')).toEqual([]);
    p.cover_letter.before = 'Before that: 29 months building a student platform on NestJS and Prisma over PostgreSQL, still in production.';
    expect(validatePlan(p, k, 'en', 'fullstack').join(' ')).toMatch(/"29 months" doesn't match/);
  });
  it('blanks the voice sample durations and trims an overlong summary at a sentence end', async () => {
    const { maskDurations } = await import('../src/pipeline/validate.js');
    const { coercePlan } = await import('../src/pipeline/tailor.js');
    expect(maskDurations('Quick snapshot: a year of end-to-end work. Before that: a year on an Elixir platform, 3+ years total.')).toBe('Quick snapshot: [duration] of end-to-end work. Before that: [duration] on an Elixir platform, 3+ years total.');
    const long = { summary: `${'A'.repeat(400)}. ${'B'.repeat(250)}. ${'C'.repeat(200)}.` };
    expect((coercePlan(long) as { summary: string }).summary).toBe(`${'A'.repeat(400)}. ${'B'.repeat(250)}.`);
  });
  it('renames a single misspelt key to the one that is missing, and leaves ambiguous shapes alone', async () => {
    const { coercePlan } = await import('../src/pipeline/tailor.js');
    const fixed = coercePlan({ entries: [{ engagement: 'a', englets: [{ id: 'b1', txt: null }] }, { engagement: 'c', bullets: [] }], cover_letter: { intro: 'i', snapshot: 's', before: null, prof: null } }) as { entries: unknown[]; cover_letter: unknown };
    expect(fixed.entries).toEqual([{ engagement: 'a', bullets: [{ id: 'b1', text: null }] }, { engagement: 'c', bullets: [] }]);
    expect(fixed.cover_letter).toEqual({ intro: 'i', snapshot: 's', before: null, proof: null });
    const extra = { engagement: 'a', bullets: [], note: 'x' };
    const twoOff = { engagment: 'a', englets: [] };
    expect((coercePlan({ entries: [extra, twoOff] }) as { entries: unknown[] }).entries).toEqual([extra, twoOff]);
  });
});

describe('language, seniority and Java (review of the first real packs)', () => {
  it('rejects English sentences inside a Ukrainian letter', () => {
    const p = clone(good);
    p.cover_letter.intro = 'Я — Алекс, fullstack-інженер із 3,5 роками досвіду в TypeScript, React і NestJS, і хочу долучитися до команди Acme iGaming.';
    p.recruiter_message = { note: UK_PITCH, message: UK_PITCH };
    p.cover_letter.snapshot = 'Коротко: рік повної відповідальності за гру винагород на NestJS, React і PostgreSQL.';
    p.cover_letter.before = "До цього: студентська платформа на NestJS і Prisma. So picking up new stacks isn't a claim — it's my track record.";
    p.cover_letter.proof = null;
    expect(validatePlan(p, k, 'uk', 'fullstack').join(' ')).toMatch(/"So picking up new stacks isn't a claim" is English/);
  });
  it('keeps Java out of a TypeScript application and allows it for Java roles', () => {
    const p = clone(good);
    p.summary = `${p.summary} Backed by Java/Spring and a regulated-sector track record.`;
    p.entries.push({ engagement: 'permits', bullets: [{ id: 'pm.application-validation', text: null }] });
    const errs = validatePlan(p, k, 'en', 'fullstack').join(' ');
    expect(errs).toMatch(/summary: mentions (Java, Spring|Spring, Java) — this is a fullstack application/);
    expect(errs).toMatch(/"pm.application-validation" is about (Java, Spring|Spring, Java)/);
    p.headline = 'Java Developer · Java / Spring Boot / PostgreSQL';
    expect(validatePlan(p, k, 'en', 'java').join(' ')).not.toMatch(/Java/);
  });
  it('allows Java in a TypeScript application when the vacancy asks for it', () => {
    const p = clone(good);
    p.summary = `${p.summary} Backed by Java/Spring and a regulated-sector track record.`;
    p.entries.push({ engagement: 'permits', bullets: [{ id: 'pm.application-validation', text: null }] });
    const wanted = detectTech('Senior Backend Developer (Node.js + Java). Strong hands-on experience with Node.js and TypeScript, Java and Spring Boot.');
    expect(validatePlan(p, k, 'en', 'fullstack', wanted).join(' ')).not.toMatch(/Java|Spring/);
    // A posting that only says JavaScript doesn't open the door.
    expect(validatePlan(p, k, 'en', 'fullstack', detectTech('JavaScript, TypeScript, React')).join(' ')).toMatch(/this is a fullstack application/);
  });
  it('drops titles below pipeline.minSeniority, trainee / intern always, keeps Junior+/Middle', async () => {
    const { seniorityCheck } = await import('../src/pipeline/prefilter.js');
    const entry = ['Trainee Node.js Developer (AI-Augmented Development)', 'Trainee Full-Stack JS Software Engineer', 'Java Intern', 'Стажер Front-End'];
    const junior = ['Junior Frontend Developer', 'Jr. React Developer', 'Entry-Level Software Engineer', 'Trainee/Junior React Developer', 'Full-Stack Developer (trainee, junior, strong junior) (React'];
    const fine = ['Junior+/Middle Node.js Developer', 'Junior-Middle Backend Developer', 'Middle Strong React Developer', 'Senior Full Stack Engineer', 'Full-Stack Developer'];
    for (const t of [...entry, ...junior]) expect(seniorityCheck(t, 'middle').pass, t).toBe(false);
    for (const t of fine) expect(seniorityCheck(t, 'middle').pass, t).toBe(true);
    for (const t of entry) expect(seniorityCheck(t, 'junior'), t).toEqual({ pass: false, reason: 'title: trainee / intern role' });
    for (const t of [...junior, ...fine]) expect(seniorityCheck(t, 'junior').pass, t).toBe(true);
  });
  it('rejects roles screening rates below pipeline.minSeniority', () => {
    const t = JSON.parse(fs.readFileSync('fixtures/llm/dou_900001.triage.json', 'utf8'));
    const p = loadConfig('config/agent.yaml').pipeline;
    expect(decide({ ...t, seniority: 'junior' }, [], { ...p, minSeniority: 'middle' })).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/junior/) });
    expect(decide({ ...t, seniority: 'middle' }, [], { ...p, minSeniority: 'middle' }).status).toBe('tailor_pending');
    expect(decide({ ...t, seniority: 'junior' }, [], { ...p, minSeniority: 'junior' }).status).toBe('tailor_pending');
    expect(decide({ ...t, seniority: 'middle' }, [], { ...p, minSeniority: 'senior' }).status).toBe('rejected');
    expect(decide({ ...t, seniority: 'unknown' }, [], { ...p, minSeniority: 'senior' }).status).toBe('tailor_pending');
  });
});

describe('years the candidate is happy to apply for', () => {
  it('tells screening that asks up to yearsOk are fine', async () => {
    const { bootstrap } = await import('../src/bootstrap.js');
    const ctx = await bootstrap('config/demo.yaml', { quiet: true, overrides: { paths: { db: ':memory:' } } });
    try {
      expect(ctx.prompts.triage.version).toBe('triage/v13');
      expect(ctx.prompts.triage.text).toContain('asking for up to 5 years');
    } finally { await ctx.close(); }
  });
});

describe('Metricly claims the TypeScript framework the vacancy asks for ("under a year of NestJS")', () => {
  const eng = (kv: Knowledge) => kv.engagements.get('metrics')!;
  it('fills {framework} with what the posting names, else the default', () => {
    const nest = forVacancy(k, detectTech('Backend developer: TypeScript, NestJS, PostgreSQL'));
    expect(eng(nest).tagline).toBe('Elixir / TypeScript (NestJS) / Python');
    expect(nest.bullets.get('metrics.search-messaging')!.text).toContain('on TypeScript services (NestJS)');
    expect(nest.scopes.get('metrics')!.has('nestjs')).toBe(true);
    const plain = forVacancy(k, detectTech('Frontend: React, TypeScript'));
    expect(eng(plain).tagline).toBe('Elixir / TypeScript (Express.js) / Python');
    expect(plain.scopes.get('metrics')!.has('nestjs')).toBe(false);
  });
  it('counts Metricly toward NestJS years: Campus + Metricly + Questify run 2023-03 – 2026-04 without a break', () => {
    expect(yearsWithTech(k.profile, 'NestJS', k.now)).toBe(3);
  });
  it('lets a rewritten Metricly bullet say NestJS only when the vacancy asks for it, and never the placeholder', () => {
    const p = clone(good);
    const entry = p.entries.find((e) => e.engagement === 'metrics')!;
    entry.bullets = [{ id: 'metrics.search-messaging', text: 'Services needed search, flexible per-user data and asynchronous messaging — worked with Elasticsearch, MongoDB and RabbitMQ behind GraphQL and REST APIs on NestJS services, containerised with Docker on AWS.' }];
    const nest = detectTech('NestJS');
    expect(validatePlan(p, forVacancy(k, nest), 'en', 'fullstack', nest)).toEqual([]);
    expect(validatePlan(p, forVacancy(k, new Set()), 'en', 'fullstack').join(' ')).toMatch(/NestJS, which is not in Metricly's stack/);
    entry.bullets[0].text = 'Services needed search — worked with Elasticsearch behind REST APIs on {framework} services.';
    expect(validatePlan(p, forVacancy(k, nest), 'en', 'fullstack', nest).join(' ')).toMatch(/never the placeholder/);
  });
});
