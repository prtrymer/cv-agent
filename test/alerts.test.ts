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
  id: '<alert-1@linkedin.com>', from: 'jobs-noreply@linkedin.com', subject: 'Anton, apply now: “Senior Java Developer at Acme Software”', date: '2026-09-22T07:00:00Z', text: '',
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

async function makeCtx(transport: MockTransport) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agent-alerts-'));
  return bootstrap('config/demo.yaml', {
    quiet: true, fresh: true, transport, now: () => new Date('2026-09-22T09:00:00Z'),
    overrides: { paths: { out: tmp, logs: path.join(tmp, 'logs'), db: path.join(tmp, 'state.db') }, render: { engine: 'none' }, http, alerts: { enabled: true } },
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
  it('keeps opaque Jobs.cz trackers with the lines they sit on', () => {
    const { links } = readAlertEmail(JOBSCZ_ALERT);
    expect(links.map((l) => [l.key, l.lines[0]])).toEqual([
      [null, 'Java vývojář/ka [job 1]'], [null, 'Účetní [job 2]'], [null, 'Odhlásit e-maily z tohoto hledání [job 3]'],
    ]);
  });
});

describe('alerts → vacancies', () => {
  it('resolves LinkedIn jobs to the company board, lists the rest, and never reads an email twice', async () => {
    stubFetch([
      ['boards-api.greenhouse.io/v1/boards/acmesoftware/jobs', { jobs: [
        { id: 77, title: 'Java Developer (Spring)', company_name: 'Acme Software', location: { name: 'Prague, Czechia' }, content: '&lt;p&gt;Java 17, Spring Boot, PostgreSQL. Hybrid in Prague.&lt;/p&gt;' },
        { id: 78, title: 'Accountant', company_name: 'Acme Software', location: { name: 'Prague' }, content: '' },
      ] }],
      ['boards-api.greenhouse.io/v1/boards/acmesoftware', { name: 'Acme Software' }],
    ]);
    const transport = new MockTransport(path.resolve('fixtures/llm'), [extracted([
      { link: 'job 1', title: 'Senior Java Developer', company: 'Acme Software s.r.o.', location: 'Prague, Czechia (Hybrid)' },
      { link: 'job 2', title: 'Frontend Engineer (React)', company: 'Nowhere Labs', location: 'Brno, Czechia (Remote)' },
    ])]);
    const ctx = await makeCtx(transport);
    const mail: MailSource = { fetch: async () => [LINKEDIN_ALERT] };
    try {
      const s = await runPipeline(ctx, { sources: ['alerts'], mail });
      expect(s.discovered).toBe(2);
      expect(ctx.store.get('greenhouse:acmesoftware:77')).toMatchObject({ source: 'alert-linkedin', company: 'Acme Software', url: 'https://job-boards.greenhouse.io/acmesoftware/jobs/77' });
      expect(ctx.store.aliasGet('linkedin:4100000001')?.vacancy_id).toBe('greenhouse:acmesoftware:77');
      expect(s.unresolved).toEqual([expect.objectContaining({ title: 'Frontend Engineer (React)', company: 'Nowhere Labs', url: 'https://www.linkedin.com/jobs/view/4100000002/' })]);
      expect(buildReport(ctx, s)).toContain('In your alerts, not on a company board');
      // …and kept on the dashboard's "Only on LinkedIn & co" tab, ready for pasted text.
      expect(ctx.store.get('linkedin:4100000002')).toMatchObject({ status: 'external', source: 'alert-linkedin', company: 'Nowhere Labs', text: '' });

      const again = await runPipeline(ctx, { sources: ['alerts'], mail });
      expect(again.discovered).toBe(0);
      expect(transport.calls).toBe(2); // extract once + triage once; the second run read nothing
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('follows a Jobs.cz tracker only for a job title on its own line, never the unsubscribe link', async () => {
    const calls = stubFetch([['track.jobs.cz/f/a/opaque1', new Response(null, { status: 302, headers: { location: 'https://www.jobs.cz/rpd/2001420353/?utm_source=email' } })]]);
    // The model wrongly offers the unsubscribe token as a job: it is fed back once, then dropped.
    const bad = { link: 'job 3', title: 'Java vývojář/ka', company: 'Kostka Bank a.s.', location: 'Praha – Dejvice' };
    const good = { link: 'job 1', title: 'Java vývojář/ka', company: 'Kostka Bank a.s.', location: 'Praha – Dejvice' };
    const accountant = { link: 'job 2', title: 'Účetní', company: 'Firma s.r.o.', location: 'Brno' };
    const transport = new MockTransport(null, [extracted([bad, accountant]), extracted([good, accountant])]);
    const ctx = await makeCtx(transport);
    try {
      const s = await runPipeline(ctx, { sources: ['alerts'], mail: { fetch: async () => [JOBSCZ_ALERT] } });
      const followed = calls.filter((c) => c.url.includes('track.jobs.cz')).map((c) => `${c.method} ${c.url.slice(-12)}`);
      expect(followed).toEqual(['HEAD ~/encrypted1']); // the job's tracker only: not the accountant (title filtered), never unsubscribe
      expect(s.unresolved).toEqual([expect.objectContaining({ title: 'Java vývojář/ka', url: 'https://www.jobs.cz/rpd/2001420353/' })]);
      expect(ctx.store.aliasGet('jobscz:2001420353')).toBeTruthy();
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('reads Djinni postings straight from their page', async () => {
    const page = `<html><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Full Stack Developer', hiringOrganization: { name: 'Out of the Box Systems' }, jobLocationType: 'TELECOMMUTE', description: '<p>Node.js, React, PostgreSQL. Fully remote.</p>' })}</script></html>`;
    stubFetch([['djinni.co/jobs/849663', page]]);
    const transport = new MockTransport(path.resolve('fixtures/llm'), [extracted([{ link: 'job 1', title: 'FULL STACK DEVELOPER', company: 'Out of the Box Systems', location: 'Тільки віддалено' }])]);
    const ctx = await makeCtx(transport);
    try {
      await runPipeline(ctx, { sources: ['alerts'], mail: { fetch: async () => [DJINNI_ALERT] } });
      expect(ctx.store.get('djinni:849663')).toMatchObject({ source: 'alert-djinni', title: 'Full Stack Developer', company: 'Out of the Box Systems', location: 'Remote' });
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
