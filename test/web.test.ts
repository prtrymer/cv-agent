import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import type { Ctx } from '../src/ctx.js';
import type { Transport } from '../src/llm/client.js';
import { MockTransport, reply } from '../src/llm/mock.js';
import { runPipeline } from '../src/pipeline/run.js';
import { startServer } from '../src/web/server.js';

let ctx: Ctx;
let answersFile = '';
let srv: { url: string; close: () => Promise<void> };
const post = (p: string, body: unknown = {}, headers: Record<string, string> = { 'x-cv-agent': '1' }) =>
  fetch(new URL(p, srv.url), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = async (p: string) => (await fetch(new URL(p, srv.url))).json() as Promise<any>;
const until = async (fn: () => Promise<boolean>, ms = 60_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error('timed out'); };

beforeAll(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agent-web-'));
  answersFile = path.join(tmp, 'answers.yaml');
  fs.copyFileSync('data/answers.yaml', answersFile);
  const fixtures = new MockTransport(path.resolve('fixtures/llm'));
  // Form questions: the model knows none of them, so the salary question comes to the page.
  const transport: Transport = {
    async send(body) {
      const b = body as any;
      if (b.tools?.[0]?.function?.name !== 'submit_answers') return fixtures.send(body);
      const qs = String(b.messages.find((m: any) => m.role === 'user').content).split('\n').filter((l) => l.startsWith('{"id"')).map((l) => JSON.parse(l));
      return reply({ toolCall: { name: 'submit_answers', args: JSON.stringify({ answers: qs.map((q: any) => ({ id: q.id, value: /why/i.test(q.question) ? 'I have shipped NestJS and React products end to end.' : null, basis: /why/i.test(q.question) ? 'fact' : 'unknown' })) }) } });
    },
  };
  ctx = await bootstrap('config/demo.yaml', {
    quiet: true, fresh: true, transport, now: () => new Date('2026-09-22T09:00:00Z'),
    overrides: { paths: { out: tmp, logs: path.join(tmp, 'logs'), db: path.join(tmp, 'state.db'), answers: path.join(tmp, 'answers.yaml'), appliedSeed: path.join(tmp, 'applied.txt') }, render: { engine: 'none' } },
  });
  fs.writeFileSync(path.join(tmp, 'applied.txt'), '');
  await runPipeline(ctx);
  srv = await startServer({ config: 'config/demo.yaml', port: 0, ctx });
}, 60_000);
afterAll(async () => { await srv?.close(); await ctx?.close(); });

describe('dashboard', () => {
  it('serves the page and every gathered vacancy with its pack files', async () => {
    expect(await (await fetch(srv.url)).text()).toContain('<title>cv-agent</title>');
    const vs = await get('/api/vacancies');
    const ready = vs.find((v: any) => v.status === 'ready');
    expect(ready).toMatchObject({ id: 'dou:900001', score: 88, family: 'fullstack', company: 'Acme iGaming' });
    expect(ready.pack.files).toContain('cover_letter.txt');
    const letter = await fetch(new URL(`/packs/${encodeURIComponent(ready.pack.dir)}/cover_letter.txt`, srv.url));
    expect(await letter.text()).toMatch(/^Hi!/);
    expect(vs.map((v: any) => v.status)).toEqual(expect.arrayContaining(['ready', 'rejected', 'filtered']));
  });

  it('refuses writes from anything but the page, other hosts, and paths outside the packs', async () => {
    expect((await post('/api/vacancies/djinni%3A900002/dismissed', {}, {})).status).toBe(403);
    // fetch() won't send a foreign Host header (DNS rebinding looks like this), so use a raw request.
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: new URL(srv.url).port, path: '/api/vacancies', headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
    });
    expect(status).toBe(403);
    expect((await fetch(new URL('/packs/..%2F..%2Fetc%2Fpasswd', srv.url))).status).toBe(404);
  });

  it('dismisses and restores a vacancy', async () => {
    expect((await post('/api/vacancies/djinni%3A900002/dismissed')).status).toBe(200);
    expect(ctx.store.get('djinni:900002')?.status).toBe('dismissed');
    expect((await post('/api/vacancies/djinni%3A900002/triage')).status).toBe(200);
    expect(ctx.store.get('djinni:900002')?.status).toBe('triage_pending');
  });

  it('turns a LinkedIn-only vacancy into a CV pack from pasted text, and only that one', async () => {
    ctx.store.insertIfNew({ id: 'linkedin:4100000009', source: 'alert-linkedin', url: 'https://www.linkedin.com/jobs/view/4100000009/', title: 'Full-Stack Developer (NestJS / Next.js)', company: 'Acme iGaming', location: 'Remote', text: '', lang: null, posted_at: null, status: 'external', status_reason: 'company has no board on a supported ATS' });
    expect((await get('/api/vacancies')).find((v: any) => v.id === 'linkedin:4100000009').status).toBe('external');
    expect((await post('/api/vacancies/linkedin%3A4100000009/text', { text: 'too short' })).status).toBe(400);
    const posting = 'Acme iGaming builds real-money casino products for regulated markets. We are looking for a Full-Stack Developer to own features end to end. Requirements: TypeScript, NestJS and Node.js on the backend, PostgreSQL, Redis, Next.js / React on the frontend, real-time features over WebSocket. Fully remote.';
    const before = ctx.store.byStatus(['triage_pending']).length;
    expect((await post('/api/vacancies/linkedin%3A4100000009/text', { text: posting })).status).toBe(200);
    await until(async () => !(await get('/api/jobs')).run.running);
    expect(ctx.store.get('linkedin:4100000009')).toMatchObject({ status: 'ready' });
    expect(ctx.store.byStatus(['triage_pending']).length).toBe(before); // the rest of the queue wasn't touched
  }, 60_000);

  it.skipIf(!fs.existsSync(chromium.executablePath()))('previews a form fill and takes a question from the page', async () => {
    const form = pathToFileURL(path.resolve('fixtures/forms/application.html')).href;
    // The dashboard applies to the posting's own form; point this vacancy at the local test form.
    ctx.store.db.prepare('UPDATE vacancies SET url = ? WHERE id = ?').run(form, 'dou:900001');
    expect((await post('/api/vacancies/dou%3A900001/preview')).status).toBe(200);
    await until(async () => Boolean((await get('/api/jobs')).apply?.question));
    const { apply } = await get('/api/jobs');
    expect(apply.question.label).toMatch(/salary/i);
    expect((await post('/api/answer', { answer: '4000 EUR' })).status).toBe(200);
    await until(async () => !(await get('/api/jobs')).apply.running);
    expect((await get('/api/jobs')).apply.result).toMatch(/Preview ready: \d+ fields filled, 0 left for you/);
  }, 90_000);

  it.skipIf(!fs.existsSync(chromium.executablePath()))('never gets stuck: cancelling while the form waits on you frees Apply again', async () => {
    // Fresh answers (the salary answered in the previous test was saved), and the local test form.
    fs.copyFileSync('data/answers.yaml', answersFile);
    ctx.store.db.prepare('UPDATE vacancies SET url = ? WHERE id = ?').run(pathToFileURL(path.resolve('fixtures/forms/application.html')).href, 'dou:900001');
    expect((await post('/api/vacancies/dou%3A900001/preview')).status).toBe(200);
    await until(async () => Boolean((await get('/api/jobs')).apply?.question));
    expect((await post('/api/vacancies/dou%3A900001/apply')).status).toBe(409); // one form at a time
    expect((await post('/api/apply/cancel')).status).toBe(200);
    await until(async () => !(await get('/api/jobs')).apply.running, 20_000);
    expect((await get('/api/jobs')).apply.result).toMatch(/Cancelled — nothing was submitted/);
    expect((await post('/api/vacancies/dou%3A900001/preview')).status).toBe(200); // the button works again
    await until(async () => Boolean((await get('/api/jobs')).apply?.question));
    await post('/api/apply/cancel');
    await until(async () => !(await get('/api/jobs')).apply.running, 20_000);
  }, 90_000);
});
