import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { MockTransport, reply } from '../src/llm/mock.js';
import { runPipeline } from '../src/pipeline/run.js';
import { buildReport } from '../src/report.js';
import { decodeTracker, readAlertEmail } from '../src/sources/alerts.js';
import type { AlertMail, MailSource } from '../src/sources/mail.js';

// Link shapes copied from real alert emails (2026-09-23); the cards themselves are made up.
const indeedLink = (u: string) => `https://cts.indeed.com/v3/${gzipSync(JSON.stringify({ u, m: {} })).toString('base64url')}`;
const djinniLink = (url: string) => `https://mandrillapp.com/track/click/30993465/djinni.co?p=${Buffer.from(JSON.stringify({ s: 'x', v: 1, p: JSON.stringify({ u: 1, v: 1, url }) })).toString('base64url')}`;
const jobsCzLink = (n: number) => `https://track.jobs.cz/f/a/opaque${n}~~/AADn-RA~/encrypted${n}`;

/** LinkedIn's layout: a logo link to the job first, then the title link, then "company · location". */
const LINKEDIN_ALERT: AlertMail = {
  id: '<alert-1@linkedin.com>', from: 'jobs-noreply@linkedin.com', subject: 'Alex, apply now: “Senior Java Developer at Acme Software”', date: '2026-09-22T07:00:00Z', text: '',
  html: `<html><body><table>
    <tr><td><a href="https://www.linkedin.com/comm/jobs/view/4100000001/?trackingId=abc%3D%3D&refId=x"><img src="logo.png"></a></td></tr>
    <tr><td><a href="https://www.linkedin.com/comm/jobs/view/4100000001/?trackingId=abc%3D%3D&refId=y">Senior Java Developer</a></td></tr>
    <tr><td>Acme Software s.r.o. · Prague, Czechia (Hybrid)</td></tr>
    <tr><td><a href="https://www.linkedin.com/comm/jobs/view/4100000002/?trackingId=def">Frontend Engineer (React)</a></td></tr>
    <tr><td>Nowhere Labs · Brno, Czechia (Remote)</td></tr>
    <tr><td><a href="https://www.linkedin.com/comm/jobs/search/?keywords=java">See all jobs</a>
      <a href="https://www.linkedin.com/comm/psettings/email-unsubscribe?x=1">Unsubscribe</a></td></tr>
  </table></body></html>`,
};

/** Jobs.cz: every link is an encrypted tracker, the footer's unsubscribe link included. */
const JOBSCZ_ALERT: AlertMail = {
  id: '<alert-2@jobs.cz>', from: 'pomuzeme@jobs.cz', subject: '2 nové nabídky', date: null, text: '',
  html: `<p>Dobrý den, posíláme výběr:</p>
    <p><a href="${jobsCzLink(1)}">Java vývojář/ka</a></p><p>Kostka Bank a.s. •</p><p>Praha – Dejvice</p>
    <p><a href="${jobsCzLink(2)}">Účetní</a></p><p>Firma s.r.o. •</p><p>Brno</p>
    <p><a href="${jobsCzLink(3)}">Odhlásit e-maily z tohoto hledání</a></p>`,
};

const DJINNI_ALERT: AlertMail = {
  id: '<alert-3@djinni.co>', from: 'magic@djinni.co', subject: 'Нові вакансії за вашим профілем', date: null, text: '',
  html: `<p>Out of the Box Systems</p><p><a href="${djinniLink('https://djinni.co/jobs/849663-full-stack-developer/?ref=email&utm_medium=email')}">FULL STACK DEVELOPER</a> $$$$</p>
    <p>Тільки віддалено · Весь світ</p><p><a href="${djinniLink('https://djinni.co/?utm_medium=email')}">Дивитися на Djinni</a></p>`,
};

/** robota.ua: plain links with utm tracking, and links to the site itself that aren't jobs. */
const ROBOTA_ALERT: AlertMail = {
  id: '<alert-4@robota.ua>', from: 'jobalert@robota.ua', subject: 'Нові вакансії', date: null, text: '',
  html: `<p><a href="https://robota.ua/company500001/vacancy11000001?utm_source=jobalert&utm_medium=email">Java developer (middle+)</a></p><p>Nowhere Processing LLC · Київ</p>
    <p><a href="https://robota.ua/company500001/vacancy11000001?utm_source=jobalert&utm_content=apply">Відгукнутися</a></p>
    <p><a href="https://robota.ua/zapros/java/kyiv?utm_source=jobalert">Усі вакансії</a></p>`,
};

const http = { minIntervalMsPerHost: 0 };
afterEach(() => vi.unstubAllGlobals());

/** Routes fetch() by URL substring. A route may return a Response (for redirects); everything else is a 404. */
function stubFetch(routes: Array<[string, unknown]>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const hit = routes.find(([k]) => url.includes(k));
    if (!hit) return new Response('{"error":"not found"}', { status: 404 });
    if (hit[1] instanceof Response) return hit[1].clone();
    return new Response(typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]), { status: 200 });
  });
  return calls;
}

/** `applied` = the lines of your tracking file (the demo one by default). */
async function makeCtx(transport: MockTransport, applied?: string[]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agent-alerts-'));
  const appliedSeed = applied ? path.join(tmp, 'applied.txt') : 'fixtures/applied.txt';
  if (applied) fs.writeFileSync(appliedSeed, applied.join('\n'));
  return bootstrap('config/demo.yaml', {
    quiet: true, fresh: true, transport, now: () => new Date('2026-09-22T09:00:00Z'),
    overrides: {
      paths: { out: tmp, logs: path.join(tmp, 'logs'), db: path.join(tmp, 'state.db'), appliedSeed }, render: { engine: 'none' }, http,
      alerts: { enabled: true },
      pipeline: { approveBeforeTailor: true },
    },
  });
}
const extracted = (jobs: unknown[]) => reply({ toolCall: { name: 'submit_jobs', args: JSON.stringify({ jobs }) } });
describe('alert email reading', () => {
  it('decodes Indeed and Djinni trackers offline', () => {
    expect(decodeTracker(indeedLink('https://cz.indeed.com/rc/clk?jk=258cc4353bc58c9a&from=email'))).toBe('https://cz.indeed.com/rc/clk?jk=258cc4353bc58c9a&from=email');
    expect(decodeTracker(djinniLink('https://djinni.co/jobs/849663-x/'))).toBe('https://djinni.co/jobs/849663-x/');
  });
  it('turns job links into tokens, one per job, and drops every other link', () => {
    const { text, links } = readAlertEmail(LINKEDIN_ALERT);
    expect(links.map((l) => [l.token, l.key])).toEqual([['job 1', 'linkedin:4100000001'], ['job 2', 'linkedin:4100000002']]);
    expect(text).toContain('Senior Java Developer [job 1]');
    expect(text).not.toMatch(/https?:|trackingId|unsubscribe\?/);
  });
  it('keeps robota.ua vacancy links, one token per vacancy, not its search pages', () => {
    const { links } = readAlertEmail(ROBOTA_ALERT);
    expect(links.map((l) => [l.token, l.key, l.url])).toEqual([['job 1', 'robota:11000001', 'https://robota.ua/company500001/vacancy11000001']]);
  });
  it('keeps opaque Jobs.cz trackers with the lines they sit on', () => {
    const { links } = readAlertEmail(JOBSCZ_ALERT);
    expect(links.map((l) => [l.key, l.lines[0]])).toEqual([
      [null, 'Java vývojář/ka [job 1]'], [null, 'Účetní [job 2]'], [null, 'Odhlásit e-maily z tohoto hledání [job 3]'],
    ]);
  });
});

describe('alerts → links, never screened', () => {
  it('lists every job under its email without opening a single page, and never reads an email twice', async () => {
    const calls = stubFetch([]);
    const transport = new MockTransport(null, [extracted([
      { link: 'job 1', title: 'Senior Java Developer', company: 'Acme Software s.r.o.', location: 'Prague, Czechia (Hybrid)' },
      { link: 'job 2', title: 'Frontend Engineer (React)', company: 'Nowhere Labs', location: 'Brno, Czechia (Remote)' },
    ])]);
    const ctx = await makeCtx(transport);
    const mail: MailSource = { fetch: async () => [LINKEDIN_ALERT] };
    try {
      const s = await runPipeline(ctx, { sources: ['alerts'], mail });
      expect(calls).toEqual([]); // no company-board lookups, no public postings
      expect(transport.calls).toBe(1); // reading the email; nothing screened
      expect(ctx.store.get('linkedin:4100000001')).toMatchObject({ status: 'external', source: 'alert-linkedin', title: 'Senior Java Developer', company: 'Acme Software s.r.o.', mail_id: LINKEDIN_ALERT.id, posted_at: LINKEDIN_ALERT.date });
      expect(ctx.store.get('linkedin:4100000002')).toMatchObject({ status: 'external', url: 'https://www.linkedin.com/jobs/view/4100000002/' });
      expect(s.alertJobs.map((j) => j.title)).toEqual(['Senior Java Developer', 'Frontend Engineer (React)']);
      expect(s.triaged).toEqual({ apply: 0, reject: 0, review: 0 });
      expect(buildReport(ctx, s)).toContain('From your job alerts (links only, not screened)');

      const again = await runPipeline(ctx, { sources: ['alerts'], mail });
      expect(again.discovered).toBe(0);
      expect(transport.calls).toBe(1);
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('notes a company you already applied to, and skips a link you applied to', async () => {
    stubFetch([]);
    const alert: AlertMail = { ...LINKEDIN_ALERT, id: '<alert-9@linkedin.com>', html: LINKEDIN_ALERT.html.replace('Nowhere Labs', 'Example Labs') };
    const transport = new MockTransport(null, [extracted([
      { link: 'job 1', title: 'Senior Java Developer', company: 'Acme Software s.r.o.', location: null },
      { link: 'job 2', title: 'Frontend Engineer (React)', company: 'Example Labs', location: null },
    ])]);
    const ctx = await makeCtx(transport, ['https://www.linkedin.com/jobs/view/4100000001/', 'https://jobs.dou.ua/companies/examplelabs/vacancies/900338/']);
    try {
      const s = await runPipeline(ctx, { sources: ['alerts'], mail: { fetch: async () => [alert] } });
      expect(ctx.store.get('linkedin:4100000001')).toBeUndefined();
      expect(ctx.store.get('linkedin:4100000002')).toMatchObject({ status: 'external', status_reason: 'already applied to examplelabs: https://jobs.dou.ua/companies/examplelabs/vacancies/900338/' });
      expect(s.alertJobs).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('follows Jobs.cz trackers for their id only, never the unsubscribe link', async () => {
    const calls = stubFetch([['track.jobs.cz/f/a/opaque1', new Response(null, { status: 302, headers: { location: 'https://www.jobs.cz/rpd/2001420353/?utm_source=email' } })]]);
    // The model wrongly offers the unsubscribe token as a job: it is fed back once, then dropped.
    const bad = { link: 'job 3', title: 'Java vývojář/ka', company: 'Kostka Bank a.s.', location: 'Praha – Dejvice' };
    const good = { link: 'job 1', title: 'Java vývojář/ka', company: 'Kostka Bank a.s.', location: 'Praha – Dejvice' };
    const accountant = { link: 'job 2', title: 'Účetní', company: 'Firma s.r.o.', location: 'Brno' };
    const transport = new MockTransport(null, [extracted([bad, accountant]), extracted([good, accountant])]);
    const ctx = await makeCtx(transport);
    try {
      const s = await runPipeline(ctx, { sources: ['alerts'], mail: { fetch: async () => [JOBSCZ_ALERT] } });
      const followed = calls.map((c) => `${c.method} ${c.url.slice(-12)}`);
      expect(followed).toEqual(['HEAD ~/encrypted1', 'HEAD ~/encrypted2']); // HEAD only, never the unsubscribe link
      expect(ctx.store.get('jobscz:2001420353')).toMatchObject({ status: 'external', url: 'https://www.jobs.cz/rpd/2001420353/' });
      expect(s.alertJobs).toHaveLength(2); // the accountant too: alerts are yours to judge
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('a Djinni alert job the feed already brought in stays with the feed (and is screened there)', async () => {
    const calls = stubFetch([]);
    const transport = new MockTransport(null, [extracted([{ link: 'job 1', title: 'FULL STACK DEVELOPER', company: 'Out of the Box Systems', location: 'Тільки віддалено' }])]);
    const ctx = await makeCtx(transport);
    ctx.store.insertIfNew({ id: 'djinni:849663', source: 'djinni-fullstack', url: 'https://djinni.co/jobs/849663-full-stack-developer/', title: 'Full Stack Developer', company: null, location: null, text: 'Node.js', lang: 'en', posted_at: null, status: 'shortlisted', status_reason: 'score 80' });
    try {
      const s = await runPipeline(ctx, { sources: ['alerts'], mail: { fetch: async () => [DJINNI_ALERT] } });
      expect(ctx.store.get('djinni:849663')).toMatchObject({ source: 'djinni-fullstack', status: 'shortlisted' });
      expect(s.alertJobs).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('drops model output that names a job or company the email does not contain', async () => {
    stubFetch([]);
    const invented = [{ link: 'job 1', title: 'Principal Architect', company: 'Megacorp', location: null }];
    const transport = new MockTransport(null, [extracted(invented), extracted(invented)]);
    const ctx = await makeCtx(transport);
    try {
      const s = await runPipeline(ctx, { sources: ['alerts'], mail: { fetch: async () => [LINKEDIN_ALERT] } });
      expect(s.discovered).toBe(0);
      expect(transport.calls).toBe(2); // the invented names were fed back once, then dropped
    } finally {
      await ctx.close();
    }
  }, 30_000);
});

describe('earlier verdicts under the current rules (free, no model call)', () => {
  it('moves rejected ones the rules now pass to the shortlist, and screened alert jobs back to the alert list', async () => {
    stubFetch([]);
    const transport = new MockTransport(null, []);
    const ctx = await makeCtx(transport);
    const triage = (score: number, extra = {}) => JSON.stringify({ score, decision: 'reject', role_family: 'other', seniority: 'senior', location_ok: false, hard_blockers: ['5+ years Node.js (candidate has 3.5)'], matched_requirements: [], lead_with: [], salary: null, posting_language: 'en', injection_suspected: false, ...extra });
    const add = (id: string, source: string, status: 'rejected' | 'borderline', json: string) => {
      ctx.store.insertIfNew({ id, source, url: `https://example.com/${id}`, title: 'Full Stack Developer', company: `Co ${id}`, location: null, text: 'Remote.', lang: 'en', posted_at: null, status: 'triage_pending', status_reason: null });
      ctx.store.transition(id, status, 'old verdict', { score: JSON.parse(json).score, triage_json: json });
    };
    add('dou:1', 'dou-node', 'rejected', triage(55));
    add('dou:2', 'dou-node', 'rejected', triage(40));
    add('dou:3', 'dou-node', 'borderline', triage(60, { location_ok: false, hard_blockers: ['on-site in Lviv'] }));
    add('linkedin:5', 'alert-linkedin', 'rejected', triage(30));
    try {
      const s = await runPipeline(ctx, { sources: ['dou-node'] });
      expect(s.redecided).toBe(1);
      expect(ctx.store.get('dou:1')).toMatchObject({ status: 'shortlisted', status_reason: 'score 55 (re-decided)' });
      expect(ctx.store.get('dou:2')?.status).toBe('rejected');
      expect(ctx.store.get('dou:3')).toMatchObject({ status: 'rejected', status_reason: 'location/eligibility: on-site in Lviv' });
      expect(ctx.store.get('linkedin:5')?.status).toBe('external');
      expect(transport.calls).toBe(0);
    } finally {
      await ctx.close();
    }
  }, 30_000);
});
