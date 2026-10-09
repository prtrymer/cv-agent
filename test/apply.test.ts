import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { applyTo, applyUrl, openForm, waitForConfirmation } from '../src/apply/apply.js';
import { loadLearned, pickOption, ruleAnswer, type Facts } from '../src/apply/answers.js';
import { attachDjinniCv } from '../src/apply/djinni.js';
import { onProtectedBoard, parseApplyLink, resolveApplyLink } from '../src/apply/gate.js';
import { normCompany } from '../src/ats/resolve.js';
import { highlight } from '../src/apply/fill.js';
import type { Field } from '../src/apply/scan.js';
import { buildKnowledge, loadAnswers, loadProfile } from '../src/profile/profile.js';
import { bootstrap } from '../src/bootstrap.js';
import type { Transport } from '../src/llm/client.js';
import { MockTransport, reply } from '../src/llm/mock.js';
import { runPipeline } from '../src/pipeline/run.js';

const WHY = "Java and Spring Boot work on a public-sector procurement platform, plus TypeScript product engineering — Acme's backend is where I can use both.";
const hasChromium = fs.existsSync(chromium.executablePath());

describe('answer mapping', () => {
  it('picks options the way a person would', () => {
    expect(pickOption(['Yes', 'No'], 'No')).toBe('No');
    expect(pickOption(['Less than 1', '1-2', '3-5', '5+'], '2')).toBe('1-2');
    expect(pickOption(['Less than 1', '1-2', '3-5', '5+'], '7')).toBe('5+');
    expect(pickOption(['Male', 'Female', 'Decline to self-identify'], 'Prefer not to say')).toBe('Decline to self-identify');
    expect(pickOption(['LinkedIn', 'Company website'], 'DOU')).toBeNull();
    // Cyrillic answers must map by meaning, not collapse to "" and hit the first option ("Ні" once became "Так").
    expect(pickOption(['Так', 'Ні'], 'Ні')).toBe('Ні');
    expect(pickOption(['Так', 'Ні'], 'Так')).toBe('Так');
    expect(pickOption(['Так', 'Ні'], 'No')).toBe('Ні');
    expect(pickOption(['Початковий', 'Середній', 'Вільно'], 'Вільно')).toBe('Вільно');
    expect(pickOption(['Так', 'Ні'], '???')).toBeNull();
    // Shapes seen on live Greenhouse / Lever forms.
    expect(pickOption(['Google search', 'Saw a LinkedIn job post', 'LinkedIn - a recruiter reached out'], 'LinkedIn job post')).toBe('Saw a LinkedIn job post');
    expect(pickOption(['I visited the booth at a student fair', 'I saw a job post on LinkedIn'], 'LinkedIn job post')).toBe('I saw a job post on LinkedIn');
    expect(pickOption(['LinkedIn', 'Glassdoor'], 'LinkedIn job post')).toBe('LinkedIn');
  });
  it('knows where each ATS keeps its form', () => {
    expect(applyUrl('https://jobs.lever.co/acme/0b5a4f5e-1c1d-4c1e-9f1a-111122223333')).toMatch(/\/apply$/);
    expect(applyUrl('https://jobs.ashbyhq.com/acme/0b5a4f5e-1c1d-4c1e-9f1a-111122223333')).toMatch(/\/application$/);
    expect(applyUrl('https://apply.workable.com/acme/j/ABC123/')).toBe('https://apply.workable.com/acme/j/ABC123/apply/');
    expect(applyUrl('https://job-boards.greenhouse.io/acme/jobs/1')).toBe('https://job-boards.greenhouse.io/acme/jobs/1');
  });
});

describe('rules on live-form labels', () => {
  const p = loadProfile('data/profile.yaml');
  const facts: Facts = {
    k: buildKnowledge(p.data, loadAnswers('data/answers.yaml'), p.raw, { now: new Date('2026-09-22'), maxGapMonths: 2 }),
    vacancy: { url: 'https://x', source: 'alert-linkedin', title: 'Dev', company: 'Acme' },
    files: { cv: '/p/CV.pdf', letterDocx: '/p/Letter.docx', letterText: 'Hi!' }, learned: [],
  };
  const field = (label: string, kind: Field['kind'] = 'text', options: string[] = [], required = false): Field => ({ id: '0.f0', kind, label, name: null, required, options, frame: 0 });
  it('reads names like cover_letter, spells the country as the picker does, and skips what should stay blank', () => {
    expect(ruleAnswer(field('cover_letter', 'file'), facts)?.value).toBe('/p/Letter.docx');
    expect(ruleAnswer(field('Country', 'combobox', ['Chad +235', 'Czechia +420', 'Denmark +45']), facts)?.value).toBe('Czechia +420');
    expect(ruleAnswer(field('Country', 'select', ['Croatia', 'Czech Republic', 'Slovakia']), facts)?.value).toBe('Czech Republic');
    expect(ruleAnswer(field('Twitter URL'), facts)).toMatchObject({ skip: true });
    expect(ruleAnswer(field('Autofill from resume', 'file'), facts)).toMatchObject({ skip: true });
    expect(ruleAnswer(field('Are you legally entitled to work in the country?', 'radio', ['Yes', 'No'], true), facts)?.value).toBe('Yes');
    expect(ruleAnswer(field('Are you authorized to work in the United States?', 'radio', ['Yes', 'No'], true), facts)?.value).toBe('No');
    expect(ruleAnswer(field('How did you first discover Apify?', 'text', [], true), facts)?.value).toBe('LinkedIn job post');
  });
});

describe.skipIf(!hasChromium)('assisted apply (simulate mode, local form)', () => {
  it('fills everything it can ground, asks for the rest, records it, and submits nothing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agent-apply-'));
    const answersFile = path.join(tmp, 'answers.yaml');
    fs.copyFileSync('data/answers.yaml', answersFile);

    const fixtures = new MockTransport(path.resolve('fixtures/llm'));
    let formQuestions: Array<{ id: string; question: string }> = [];
    const transport: Transport = {
      async send(body, timeoutMs) {
        const b = body as any;
        if (b.tools?.[0]?.function?.name !== 'submit_answers') return fixtures.send(body);
        const user: string = b.messages.find((m: any) => m.role === 'user').content;
        formQuestions = user.split('\n').filter((l) => l.startsWith('{"id"')).map((l) => JSON.parse(l));
        const answers = formQuestions.map((q) => (/why/i.test(q.question) ? { id: q.id, value: WHY, basis: 'fact' } : { id: q.id, value: null, basis: 'unknown' }));
        return reply({ toolCall: { name: 'submit_answers', args: JSON.stringify({ answers }) } });
      },
    };
    const ctx = await bootstrap('config/demo.yaml', {
      quiet: true, fresh: true, transport, now: () => new Date('2026-09-22T09:00:00Z'),
      overrides: { paths: { out: tmp, logs: path.join(tmp, 'logs'), db: path.join(tmp, 'state.db'), answers: answersFile }, render: { engine: 'none' } },
    });
    const asked: string[] = [];
    try {
      const s = await runPipeline(ctx);
      const pack = s.packs[0];
      expect(pack.status).toBe('ready');

      const r = await applyTo(ctx, pack.id, {
        mode: 'simulate', url: pathToFileURL(path.resolve('fixtures/forms/application.html')).href, out: () => {},
        ask: { question: async (f) => { asked.push(f.label); return /salary/i.test(f.label) ? '4000 EUR' : null; }, pause: async () => {}, link: async () => null, close: () => {} },
      });

      const got = Object.fromEntries(r.filled.map((x) => [x.label, `${x.value} (${x.source})`]));
      expect(got).toMatchObject({
        'First Name': 'Anton (rule)', 'Last Name': 'Chaika (rule)', Email: 'antn.chaika@gmail.com (rule)',
        'LinkedIn Profile': expect.stringContaining('linkedin.com/in/'),
        'Location (City)': 'Olomouc, Czech Republic (rule)',
        'Are you legally authorized to work in Czechia?': 'Yes (rule)',
        'Will you now or in the future require visa sponsorship?': 'No (rule)',
        'How many years of commercial experience do you have with Java?': '1-2 (rule)',
        'What are your salary expectations (gross, monthly)?': '4000 EUR (you)',
        'Why do you want to work at Acme Software?': expect.stringContaining('(model)'),
        Gender: 'Decline to self-identify (rule)',
        'I agree to the processing of my personal data according to the Privacy Policy': '☑ (rule)',
        'Keep my data in your talent pool for future opportunities': '☐ (rule)',
      });
      expect(got['Resume/CV']).toMatch(/Anton_Chaika_CV\.pdf \(rule\)$/);
      expect(got['Cover Letter']).toMatch(/Anton_Chaika_Cover_Letter\.docx \(rule\)$/);
      expect(r.errors).toEqual([]);
      expect(r.missing).toEqual([]);
      expect(r.status).toBe('simulated');

      // Only what rules couldn't settle went to the model; only what the model couldn't ground was asked.
      expect(formQuestions.map((q) => q.question).sort()).toEqual(['How did you hear about this job?', 'What are your salary expectations (gross, monthly)?', 'Why do you want to work at Acme Software?']);
      expect(asked).toEqual(['What are your salary expectations (gross, monthly)?']);
      expect(loadLearned(answersFile)).toEqual([expect.objectContaining({ question: 'What are your salary expectations (gross, monthly)?', answer: '4000 EUR' })]);
      expect(fs.readFileSync(answersFile, 'utf8')).toContain('# data/answers.yaml'); // comments survive

      for (const f of ['Anton_Chaika_CV.pdf', 'application-form.png', 'application.json']) expect(fs.existsSync(path.join(pack.dir, f)), f).toBe(true);
      expect(ctx.store.get(pack.id)?.status).toBe('ready'); // simulate never marks applied
    } finally {
      await ctx.close();
    }
  }, 120_000);
});

describe.skipIf(!hasChromium)('confirmation watcher', () => {
  it('ignores "thank you for your interest" on the form page and fires only after a real submit', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(path.resolve('fixtures/forms/application.html')).href);
      expect(await waitForConfirmation(page, 2500)).toBe(false);
      const watching = waitForConfirmation(page, 10_000);
      // The form's own submit handler (what a real Submit click runs once the fields validate).
      await page.evaluate('document.getElementById("application").dispatchEvent(new Event("submit", { cancelable: true }))');
      expect(await watching).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe.skipIf(!hasChromium)('confirmation watcher on Djinni', () => {
  it("fires when Djinni sends you back to the job page with ?applied=ok", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const form = pathToFileURL(path.resolve('fixtures/forms/djinni-reply.html')).href;
      await page.goto(form);
      const watching = waitForConfirmation(page, 10_000);
      await page.goto(`${form}?applied=ok`);
      expect(await watching).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe.skipIf(!hasChromium)('job-board reply forms (DOU)', () => {
  const noAsk = { question: async () => null, pause: async () => {}, link: async () => null, close: () => {} };
  it('asks you to log in when the page is logged out, and never clicks the login link itself', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const target = pathToFileURL(path.resolve('fixtures/forms/dou-logged-out.html')).href;
      await page.goto(target);
      const pauses: string[] = [];
      let popups = 0;
      page.context().on('page', () => { popups++; });
      await openForm(page, target, { mode: 'assisted', out: () => {}, ask: { ...noAsk, pause: async (m) => { pauses.push(m); } } });
      expect(pauses[0]).toMatch(/Log in to .* then press Continue/);
      expect(popups).toBe(0);
    } finally { await browser.close(); }
  }, 60_000);

  it('opens the reply form itself and puts the cover letter into its only message box', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agent-dou-'));
    const ctx = await bootstrap('config/demo.yaml', {
      quiet: true, fresh: true, transport: new MockTransport(path.resolve('fixtures/llm')), now: () => new Date('2026-09-22T09:00:00Z'),
      overrides: { paths: { out: tmp, logs: path.join(tmp, 'logs'), db: path.join(tmp, 'state.db') }, render: { engine: 'none' } },
    });
    try {
      const s = await runPipeline(ctx);
      const r = await applyTo(ctx, s.packs[0].id, { mode: 'simulate', url: pathToFileURL(path.resolve('fixtures/forms/dou-logged-in.html')).href, out: () => {}, ask: noAsk });
      const got = Object.fromEntries(r.filled.map((x) => [x.label, x]));
      expect(got['Кілька слів про себе']).toMatchObject({ source: 'rule', value: expect.stringMatching(/^Hi!/) });
      expect(got['Резюме']).toMatchObject({ value: 'Anton_Chaika_CV.pdf' });
      expect(r.errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 90_000);
});

describe.skipIf(!hasChromium)('company form opened from DOU in a new tab (live case, 2026-09-23)', () => {
  it('follows the new tab, reads Ukrainian labels and fills the rich-text cover letter', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agent-pf-'));
    fs.copyFileSync('data/answers.yaml', path.join(tmp, 'answers.yaml'));
    const fixtures = new MockTransport(path.resolve('fixtures/llm'));
    const transport: Transport = {
      async send(body) {
        const b = body as any;
        if (b.tools?.[0]?.function?.name !== 'submit_answers') return fixtures.send(body);
        const qs = String(b.messages.find((m: any) => m.role === 'user').content).split('\n').filter((l) => l.startsWith('{"id"')).map((l) => JSON.parse(l));
        return reply({ toolCall: { name: 'submit_answers', args: JSON.stringify({ answers: qs.map((q: any) => (/мобільн/.test(q.question) ? { id: q.id, value: 'Ні', basis: 'fact' } : { id: q.id, value: null, basis: 'unknown' })) }) } });
      },
    };
    const ctx = await bootstrap('config/demo.yaml', {
      quiet: true, fresh: true, transport, now: () => new Date('2026-09-22T09:00:00Z'),
      overrides: { paths: { out: tmp, logs: path.join(tmp, 'logs'), db: path.join(tmp, 'state.db'), answers: path.join(tmp, 'answers.yaml') }, render: { engine: 'none' } },
    });
    const asked: string[] = [];
    try {
      const s = await runPipeline(ctx);
      const r = await applyTo(ctx, s.packs[0].id, {
        mode: 'simulate', url: pathToFileURL(path.resolve('fixtures/forms/dou-external.html')).href, out: () => {},
        ask: { question: async (f) => { asked.push(f.label); return /компенсац/.test(f.label) ? '3500' : null; }, pause: async () => {}, link: async () => null, close: () => {} },
      });
      const got = Object.fromEntries(r.filled.map((x) => [x.label, `${x.value} (${x.source})`]));
      expect(got).toMatchObject({
        "Ім'я": 'Anton (rule)', 'Прізвище': 'Chaika (rule)', 'Електронна пошта': 'antn.chaika@gmail.com (rule)',
        'Номер телефону': '+420 606 194 392 (rule)', 'Код країни': '+420 (rule)', 'Резюме': 'Anton_Chaika_CV.pdf (rule)',
        'Чи був комерційний досвід роботи з мобільними додатками?': 'Ні (model)', 'Бажана базова компенсація': '3500 (you)',
      });
      expect(got['Супровідний лист']).toMatch(/^Hi!.*\(rule\)$/s);
      // The footer's language switcher (it reloads the page and wipes the form) is never touched.
      expect(Object.keys(got).some((k) => /PeopleForce|мова|language/i.test(k))).toBe(false);
      expect(asked).toEqual(['Бажана базова компенсація']);
      expect(r.missing).toEqual([]);
      expect(r.errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 90_000);
});

describe.skipIf(!hasChromium)('Djinni reply: the tailored CV instead of the account one', () => {
  const form = pathToFileURL(path.resolve('fixtures/forms/djinni-reply.html')).href;
  const cv = path.resolve('fixtures/forms/djinni-reply.html'); // any existing file stands in for the PDF
  it('attaches it through "+ Додати резюме", which swaps the Резюме list for an upload field', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(form);
      // The <select> disappears with the swap: waiting on it was the 30-second timeout on the first live reply (2026-09-25).
      expect(await attachDjinniCv(page, cv)).toBeNull();
      expect(await page.locator('select[name="cv_file_upload_id"]').count()).toBe(0);
      expect(await page.locator('input[name="cv_file"]').evaluate((el: any) => el.files[0]?.name)).toBe('djinni-reply.html');
      // Only this reply gets the tailored CV; the profile keeps its own.
      expect(await page.locator('input[name="save_profile_cv"]').isChecked()).toBe(false);
      // Run again (the field is already there): it sets the file without clicking anything.
      expect(await attachDjinniCv(page, cv)).toBeNull();
    } finally { await browser.close(); }
  }, 60_000);
  it('never follows a link that would leave the filled form', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${form}#navlink`);
      expect(await attachDjinniCv(page, cv)).toMatch(/opens another page — click "\+ Додати резюме" and pick/);
      expect(page.url()).toBe(`${form}#navlink`);
      expect(await page.locator('select[name="cv_file_upload_id"]').inputValue()).toBe('101');
      // …and the picker is outlined for you (highlight was a silent no-op until 2026-09-24).
      const f: Field = { id: '0.f0', kind: 'select', label: 'Резюме', name: 'cv_file_upload_id', required: false, options: [], frame: 0 };
      await page.locator('select[name="cv_file_upload_id"]').evaluate((el: any) => el.setAttribute('data-cvagent-id', 'f0'));
      await highlight(page, [f]);
      expect(await page.locator('select[name="cv_file_upload_id"]').evaluate((el: any) => el.style.outline)).toMatch(/solid 3px/);
    } finally { await browser.close(); }
  }, 60_000);
});

describe('job boards behind a bot check (We Work Remotely, 2026-09-28)', () => {
  it('knows the board and reads what you paste', () => {
    const boards = ['weworkremotely.com'];
    expect(onProtectedBoard('https://weworkremotely.com/remote-jobs/steuart-nutrition-software-developer-ai-coding', boards)).toBe(true);
    expect(onProtectedBoard('https://www.weworkremotely.com/remote-jobs/x', boards)).toBe(true);
    expect(onProtectedBoard('https://job-boards.greenhouse.io/acme/jobs/1', boards)).toBe(false);
    expect(parseApplyLink(' https://steuart.bamboohr.com/careers/42 ')).toEqual({ kind: 'form', url: 'https://steuart.bamboohr.com/careers/42' });
    expect(parseApplyLink('mailto:jobs@steuart.com?subject=Dev')).toEqual({ kind: 'email', address: 'jobs@steuart.com' });
    expect(parseApplyLink('jobs@steuart.com')).toEqual({ kind: 'email', address: 'jobs@steuart.com' });
    expect(parseApplyLink('apply now')).toBeNull();
  });

  /** A ready demo pack, moved onto a WWR posting whose company has no public ATS board (so nothing goes to the network). */
  const wwrPack = async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agent-wwr-'));
    const ctx = await bootstrap('config/demo.yaml', {
      quiet: true, fresh: true, transport: new MockTransport(path.resolve('fixtures/llm')), now: () => new Date('2026-09-22T09:00:00Z'),
      overrides: { paths: { out: tmp, logs: path.join(tmp, 'logs'), db: path.join(tmp, 'state.db') }, render: { engine: 'none' } },
    });
    const id = (await runPipeline(ctx)).packs[0].id;
    ctx.store.db.prepare('UPDATE vacancies SET url = ?, company = ? WHERE id = ?').run('https://weworkremotely.com/remote-jobs/steuart-nutrition-software-developer-ai-coding', 'Steuart Nutrition', id);
    ctx.store.boardSet(normCompany('Steuart Nutrition'), null, new Date('2026-09-22T09:00:00Z'));
    return { ctx, id };
  };

  it('opens the posting in your own browser, refuses the board itself, and remembers the link you paste', async () => {
    const { ctx, id } = await wwrPack();
    try {
      const opened: string[] = [];
      const typed = ['https://weworkremotely.com/remote-jobs/steuart-nutrition-software-developer-ai-coding', 'https://steuart.bamboohr.com/careers/42'];
      const lines: string[] = [];
      const o = { mode: 'assisted' as const, out: (l: string) => lines.push(l), openExternal: (u: string) => opened.push(u),
        ask: { question: async () => null, pause: async () => {}, link: async () => typed.shift() ?? null, close: () => {} } };
      expect(await resolveApplyLink(ctx, ctx.store.get(id)!, o)).toEqual({ kind: 'form', url: 'https://steuart.bamboohr.com/careers/42' });
      expect(opened).toEqual(['https://weworkremotely.com/remote-jobs/steuart-nutrition-software-developer-ai-coding']);
      expect(lines.join('\n')).toMatch(/that's still weworkremotely\.com/);
      // Next time: no browser, no question.
      opened.length = 0;
      expect(await resolveApplyLink(ctx, ctx.store.get(id)!, { ...o, ask: { ...o.ask, link: async () => { throw new Error('asked again'); } } })).toMatchObject({ kind: 'form' });
      expect(opened).toEqual([]);
    } finally { await ctx.close(); }
  }, 90_000);

  it('never opens the board in its window: preview without a link stops, an email link opens nothing', async () => {
    const { ctx, id } = await wwrPack();
    try {
      const opened: string[] = [];
      const o = { mode: 'simulate' as const, out: () => {}, openExternal: (u: string) => opened.push(u),
        ask: { question: async () => null, pause: async () => {}, link: async () => { throw new Error('simulate never asks'); }, close: () => {} } };
      await expect(applyTo(ctx, id, o)).rejects.toThrow(/needs its apply link first.*nothing was submitted/);
      ctx.store.applyLinkSet(id, 'mailto:jobs@steuart.com', 'you');
      const r = await applyTo(ctx, id, o);
      expect(r.status).toBe('email');
      expect(opened).toEqual([]);
      expect(JSON.parse(fs.readFileSync(path.join(r.dir, 'application.json'), 'utf8'))).toMatchObject({ email: 'jobs@steuart.com' });
    } finally { await ctx.close(); }
  }, 90_000);

  it.skipIf(!hasChromium)('fills the form behind a saved link', async () => {
    const { ctx, id } = await wwrPack();
    try {
      ctx.store.applyLinkSet(id, pathToFileURL(path.resolve('fixtures/forms/dou-logged-in.html')).href, 'you');
      const r = await applyTo(ctx, id, { mode: 'simulate', out: () => {}, ask: { question: async () => null, pause: async () => {}, link: async () => null, close: () => {} } });
      expect(r.status).toBe('simulated');
      expect(r.filled.map((x) => x.label)).toContain('Резюме');
    } finally { await ctx.close(); }
  }, 90_000);

  it.skipIf(!hasChromium)('stops at a bot-check page and hands it to your browser instead of fighting it', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const target = pathToFileURL(path.resolve('fixtures/forms/bot-wall.html')).href;
      await page.goto(target);
      const opened: string[] = [];
      await expect(openForm(page, target, { mode: 'assisted', out: () => {}, openExternal: (u) => opened.push(u),
        ask: { question: async () => null, pause: async () => { throw new Error('should not ask to log in'); }, link: async () => null, close: () => {} } }))
        .rejects.toThrow(/shows a bot check.*nothing was submitted/);
      expect(opened).toEqual([target]);
    } finally { await browser.close(); }
  }, 60_000);
});
