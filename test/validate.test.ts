import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildKnowledge, forVacancy, loadAnswers, loadProfile, resolveSkill, titleFor, yearsWithTech, type Knowledge } from '../src/profile/profile.js';
import { validatePlan, type Plan } from '../src/pipeline/validate.js';
import { detectTech } from '../src/profile/lexicon.js';
import { decide, type Triage } from '../src/pipeline/triage.js';
import { loadConfig } from '../src/config.js';

const clone = (p: Plan): Plan => JSON.parse(JSON.stringify(p));
let k: Knowledge;
let good: Plan;

beforeAll(() => {
  const profile = loadProfile('data/profile.yaml');
  k = buildKnowledge(profile.data, loadAnswers('data/answers.yaml'), profile.raw, { now: new Date('2026-09-22'), maxGapMonths: 2 });
  good = JSON.parse(fs.readFileSync('fixtures/llm/dou_900001.tailor.json', 'utf8')) as Plan;
});

describe('plan validation', () => {
  it('accepts the fixture plan', () => {
    expect(validatePlan(good, k, 'en', 'fullstack')).toEqual([]);
  });
  it('rejects a bullet borrowed from another engagement', () => {
    const p = clone(good);
    p.entries[0].bullets[0].id = 'mb.lootbox';
    expect(validatePlan(p, k, 'en', 'fullstack').join(' ')).toMatch(/does not belong to coolbet/);
  });
  it('requires the headline of the role family it was built for', () => {
    expect(validatePlan(good, k, 'en', 'java').join(' ')).toMatch(/start with "Java Developer · "/);
    const p = clone(good);
    p.headline = 'Java Developer · Java / Spring Boot / PostgreSQL';
    expect(validatePlan(p, k, 'en', 'java')).toEqual([]);
  });
  it('prints the job title the family prefers, from the titles each engagement allows', () => {
    const f = (id: 'java' | 'frontend' | 'fullstack') => k.families.get(id);
    expect(titleFor(k.engagements.get('estonia')!, f('java'))).toBe('Java Developer');
    expect(titleFor(k.engagements.get('megablocks')!, f('java'))).toBe('Backend Engineer');
    expect(titleFor(k.engagements.get('coolbet')!, f('frontend'))).toBe('Frontend Engineer');
    expect(titleFor(k.engagements.get('fice')!, f('frontend'))).toBe('Backend Engineer');
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
  it('rejects the word tailored and any gap talk', () => {
    const p = clone(good);
    p.cover_letter.proof = 'I have no commercial experience with Kubernetes, but this CV is tailored for the role.';
    const errs = validatePlan(p, k, 'en', 'fullstack').join(' ');
    expect(errs).toMatch(/tailored/);
    expect(errs).toMatch(/positive-only/);
  });
  it('rejects a timeline gap created by omitting too much', () => {
    const p = clone(good);
    p.entries = p.entries.filter((e) => e.engagement === 'coolbet' || e.engagement === 'fice');
    expect(validatePlan(p, k, 'en', 'fullstack').join(' ')).toMatch(/gap/);
  });
  it('rejects thesis-only technology used as commercial experience', () => {
    const p = clone(good);
    p.summary = `${p.summary} I run Kafka pipelines in production every day.`;
    expect(validatePlan(p, k, 'en', 'fullstack').join(' ')).toMatch(/Kafka/);
  });
  it('rejects a cover letter that writes its own greeting or mentions attachments', () => {
    const p = clone(good);
    p.cover_letter.intro = 'Hi! I am Anton and my CV is attached.';
    const errs = validatePlan(p, k, 'en', 'fullstack').join(' ');
    expect(errs).toMatch(/greeting is added by code/);
    expect(errs).toMatch(/attachments/);
  });
});

describe('role family scope', () => {
  const t: Triage = JSON.parse(fs.readFileSync('fixtures/llm/dou_900001.triage.json', 'utf8'));
  const p = loadConfig('config/agent.yaml').pipeline;
  it('tailors every family in pipeline.roleFamilies and rejects the rest', () => {
    for (const role_family of ['fullstack', 'frontend', 'backend', 'java'] as const) expect(decide({ ...t, role_family }, [], p).status).toBe('tailor_pending');
    expect(decide({ ...t, role_family: 'other' }, [], p)).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/not in pipeline.roleFamilies/) });
    expect(decide({ ...t, role_family: 'java' }, [], { ...p, roleFamilies: ['fullstack'] }).status).toBe('rejected');
  });
});

describe('durations and skill names (found in the first live run)', () => {
  it('rejects a duration copied from the voice sample for the engagement the sentence is about', () => {
    const p = clone(good);
    p.cover_letter.before = 'Before that: a year on an Elixir microservice platform (Phoenix, Ecto, OTP), so new stacks are routine.';
    expect(validatePlan(p, k, 'en', 'fullstack').join(' ')).toMatch(/"a year" doesn't match the fact base \(yolo lasted 1 year 7 months\)/);
    p.cover_letter.before = 'Before that: one and a half years on an Elixir microservice platform (Phoenix, Ecto, OTP), so new stacks are routine.';
    expect(validatePlan(p, k, 'en', 'fullstack')).toEqual([]);
  });
  it('accepts true durations and the total, and rejects invented ones', () => {
    const p = clone(good);
    p.cover_letter.snapshot = 'Quick snapshot: a year building a casino lootbox game end to end on NestJS, React and PostgreSQL, with real-time updates over WebSocket.';
    expect(validatePlan(p, k, 'en', 'fullstack')).toEqual([]);
    p.cover_letter.snapshot = 'Quick snapshot: five years building casino games end to end on NestJS, React and PostgreSQL, with real-time updates over WebSocket.';
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
    p.cover_letter.snapshot = 'Quick snapshot: five months on a licensed sportsbook platform, migrating a large React codebase with Claude Code and Codex, and a year of end-to-end ownership on a casino lootbox game built from scratch in NestJS, React and PostgreSQL.';
    expect(validatePlan(p, k, 'en', 'fullstack')).toEqual([]);
    p.cover_letter.snapshot = 'Quick snapshot: a year on a licensed sportsbook platform, migrating a large React codebase with Claude Code and Codex, and five months on a casino lootbox game built from scratch in NestJS, React and PostgreSQL.';
    const errs = validatePlan(p, k, 'en', 'fullstack').join(' ');
    expect(errs).toMatch(/"a year" doesn't match the fact base \(coolbet lasted 5 months\)/);
    expect(errs).toMatch(/"five months" doesn't match the fact base \(megablocks lasted 1 year\)/);
  });
});

describe('triage output tidying (first real run)', () => {
  it('fixes shape-only mistakes for free', async () => {
    const { coerceTriage, TriageSchema } = await import('../src/pipeline/triage.js');
    const t = JSON.parse(fs.readFileSync('fixtures/llm/dou_900001.triage.json', 'utf8'));
    const messy = { ...t, salary: '3500-4500 USD', matched_requirements: 'TypeScript and NestJS', hard_blockers: ['a', 'b', 'c', 'd', 'e', 'f'], lead_with: ['coolbet', 'megablocks', 'yolo', 'fice'] };
    expect(TriageSchema.safeParse(messy).success).toBe(false);
    const fixed = TriageSchema.parse(coerceTriage(messy));
    expect(fixed).toMatchObject({ salary: null, matched_requirements: ['TypeScript and NestJS'], hard_blockers: ['a', 'b', 'c', 'd', 'e'], lead_with: ['coolbet', 'megablocks', 'yolo'] });
  });
});

describe('Ukrainian letters (first real packs)', () => {
  it('checks Ukrainian durations and openers', () => {
    const p = clone(good);
    p.cover_letter.intro = 'Я — Антон, fullstack-інженер із 3,5 роками досвіду в TypeScript, React і NestJS, і хочу долучитися до команди Acme iGaming на позиції Full-Stack Developer.';
    p.cover_letter.proof = 'Перший проєкт, який я запустив, — студентська платформа на NestJS і Prisma — досі працює в продакшені для ~500 одночасних користувачів.';
    p.cover_letter.snapshot = 'Коротко: рік повної відповідальності за лутбокс-гру на NestJS, React і PostgreSQL, з оновленнями в реальному часі через WebSocket.';
    p.cover_letter.before = 'До цього: рік на Elixir-мікросервісній платформі (Phoenix, Ecto, OTP), тож нові стеки для мене — звична справа.';
    const errs = validatePlan(p, k, 'uk', 'fullstack').join(' ');
    expect(errs).toMatch(/"рік на" doesn't match|"рік" doesn't match/);
    expect(errs).toMatch(/yolo lasted 1 year 7 months/);
    expect(errs).not.toMatch(/snapshot/); // the lootbox "рік" is true (megablocks lasted a year)
    p.cover_letter.before = 'До цього: півтора року на Elixir-мікросервісній платформі (Phoenix, Ecto, OTP), з 2023 року — тож нові стеки для мене звична справа.';
    expect(validatePlan(p, k, 'uk', 'fullstack')).toEqual([]);
    // Years and months together are one duration, not "4 місяці" on their own (false alarms on real packs).
    for (const d of ['1 рік 7 місяців', 'рік і сім місяців', 'рік, 7 місяців']) {
      p.cover_letter.before = `До цього: ${d} на Elixir-мікросервісній платформі (Phoenix, Ecto, OTP).`;
      expect(validatePlan(p, k, 'uk', 'fullstack')).toEqual([]);
    }
    p.cover_letter.before = 'До цього: 2 роки 9 місяців на Elixir-мікросервісній платформі (Phoenix, Ecto, OTP).';
    expect(validatePlan(p, k, 'uk', 'fullstack').join(' ')).toMatch(/"2 роки 9 місяців" doesn't match/);
    p.cover_letter.snapshot = 'Quick snapshot: рік повної відповідальності за лутбокс-гру на NestJS, React і PostgreSQL.';
    expect(validatePlan(p, k, 'uk', 'fullstack').join(' ')).toMatch(/«Коротко:»/);
  });
  it('accepts a month count worked out from the dates, though the number is not in the profile', () => {
    const p = clone(good);
    p.cover_letter.proof = null;
    // FICE ran 2023-03 – 2024-01: 11 months, a number the profile never writes (false alarm on a real pack).
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
    p.cover_letter.intro = 'Я — Антон, fullstack-інженер із 3,5 роками досвіду в TypeScript, React і NestJS, і хочу долучитися до команди Acme iGaming.';
    p.cover_letter.snapshot = 'Коротко: рік повної відповідальності за лутбокс-гру на NestJS, React і PostgreSQL.';
    p.cover_letter.before = "До цього: студентська платформа на NestJS і Prisma. So picking up new stacks isn't a claim — it's my track record.";
    p.cover_letter.proof = null;
    expect(validatePlan(p, k, 'uk', 'fullstack').join(' ')).toMatch(/"So picking up new stacks isn't a claim" is English/);
  });
  it('keeps Java out of a TypeScript application and allows it for Java roles', () => {
    const p = clone(good);
    p.summary = `${p.summary} Backed by Java/Spring and a regulated-sector track record.`;
    p.entries.push({ engagement: 'estonia', bullets: [{ id: 'ee.referral-validation', text: null }] });
    const errs = validatePlan(p, k, 'en', 'fullstack').join(' ');
    expect(errs).toMatch(/summary: mentions (Java, Spring|Spring, Java) — this is a fullstack application/);
    expect(errs).toMatch(/"ee.referral-validation" is about (Java, Spring|Spring, Java)/);
    p.headline = 'Java Developer · Java / Spring Boot / PostgreSQL';
    expect(validatePlan(p, k, 'en', 'java').join(' ')).not.toMatch(/Java/);
  });
  it('allows Java in a TypeScript application when the vacancy asks for it', () => {
    const p = clone(good);
    p.summary = `${p.summary} Backed by Java/Spring and a regulated-sector track record.`;
    p.entries.push({ engagement: 'estonia', bullets: [{ id: 'ee.referral-validation', text: null }] });
    const wanted = detectTech('Senior Backend Developer (Node.js + Java). Strong hands-on experience with Node.js and TypeScript, Java and Spring Boot.');
    expect(validatePlan(p, k, 'en', 'fullstack', wanted).join(' ')).not.toMatch(/Java|Spring/);
    // A posting that only says JavaScript doesn't open the door.
    expect(validatePlan(p, k, 'en', 'fullstack', detectTech('JavaScript, TypeScript, React')).join(' ')).toMatch(/this is a fullstack application/);
  });
  it('drops trainee, intern and junior-only titles, keeps Junior+/Middle', async () => {
    const { belowMiddle } = await import('../src/pipeline/prefilter.js');
    for (const t of ['Trainee Node.js Developer (AI-Augmented Development)', 'Trainee Full-Stack JS Software Engineer', 'Junior Frontend Developer', 'Java Intern', 'Стажер Front-End', 'Jr. React Developer']) expect(belowMiddle(t), t).toBe(true);
    for (const t of ['Junior+/Middle Node.js Developer', 'Junior-Middle Backend Developer', 'Middle Strong React Developer', 'Senior Full Stack Engineer', 'Full-Stack Developer']) expect(belowMiddle(t), t).toBe(false);
  });
  it('rejects roles screening rates as junior', () => {
    const t = JSON.parse(fs.readFileSync('fixtures/llm/dou_900001.triage.json', 'utf8'));
    const p = loadConfig('config/agent.yaml').pipeline;
    expect(decide({ ...t, seniority: 'junior' }, [], p)).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/junior/) });
    expect(decide({ ...t, seniority: 'middle' }, [], p).status).toBe('tailor_pending');
  });
});

describe('years the candidate is happy to apply for', () => {
  it('tells screening that asks up to yearsOk are fine', async () => {
    const { bootstrap } = await import('../src/bootstrap.js');
    const ctx = await bootstrap('config/demo.yaml', { quiet: true, overrides: { paths: { db: ':memory:' } } });
    try {
      expect(ctx.prompts.triage.version).toBe('triage/v3');
      expect(ctx.prompts.triage.text).toContain('asking for up to 5 years');
    } finally { await ctx.close(); }
  });
});

describe('Yolo claims the TypeScript framework the vacancy asks for (Crew Matrix: "under a year of NestJS")', () => {
  const eng = (kv: Knowledge) => kv.engagements.get('yolo')!;
  it('fills {framework} with what the posting names, else the default', () => {
    const nest = forVacancy(k, detectTech('Backend developer: TypeScript, NestJS, PostgreSQL'));
    expect(eng(nest).tagline).toBe('Elixir / TypeScript (NestJS) / Python');
    expect(nest.bullets.get('yolo.search-messaging')!.text).toContain('on TypeScript services (NestJS)');
    expect(nest.scopes.get('yolo')!.has('nestjs')).toBe(true);
    const plain = forVacancy(k, detectTech('Frontend: React, TypeScript'));
    expect(eng(plain).tagline).toBe('Elixir / TypeScript (Express.js) / Python');
    expect(plain.scopes.get('yolo')!.has('nestjs')).toBe(false);
  });
  it('counts Yolo toward NestJS years: FICE + Yolo + MegaBlocks run 2023-03 – 2026-04 without a break', () => {
    expect(yearsWithTech(k.profile, 'NestJS', k.now)).toBe(3);
  });
  it('lets a rewritten Yolo bullet say NestJS only when the vacancy asks for it, and never the placeholder', () => {
    const p = clone(good);
    const entry = p.entries.find((e) => e.engagement === 'yolo')!;
    entry.bullets = [{ id: 'yolo.search-messaging', text: 'Services needed search, flexible per-user data and asynchronous messaging — worked with Elasticsearch, MongoDB and RabbitMQ behind GraphQL and REST APIs on NestJS services, containerised with Docker on AWS.' }];
    const nest = detectTech('NestJS');
    expect(validatePlan(p, forVacancy(k, nest), 'en', 'fullstack', nest)).toEqual([]);
    expect(validatePlan(p, forVacancy(k, new Set()), 'en', 'fullstack').join(' ')).toMatch(/NestJS, which is not in Yolo's stack/);
    entry.bullets[0].text = 'Services needed search — worked with Elasticsearch behind REST APIs on {framework} services.';
    expect(validatePlan(p, forVacancy(k, nest), 'en', 'fullstack', nest).join(' ')).toMatch(/never the placeholder/);
  });
});
