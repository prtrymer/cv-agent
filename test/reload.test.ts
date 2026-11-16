import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import type { Ctx } from '../src/ctx.js';
import { startServer } from '../src/web/server.js';

// The dashboard used to load config and prompts once at startup, so a prompt switch (triage v8 → v9) never reached
// runs started from it: a re-screen came back as v8's cached 48 (2026-11-12).
let tmp = '';
let configFile = '';
let ctx: Ctx;
let srv: { url: string; close: () => Promise<void> };

const writeConfig = (extra = '', db = 'state.db') => fs.writeFileSync(configFile, [
  `extends: ${path.resolve('config/demo.yaml')}`,
  `paths: { out: ${tmp}, logs: ${path.join(tmp, 'logs')}, db: ${path.join(tmp, db)}, appliedSeed: ${path.join(tmp, 'applied.txt')}, prompts: ${path.join(tmp, 'prompts')} }`,
  extra,
].join('\n'));
const get = async (p: string) => (await fetch(new URL(p, srv.url))).json() as Promise<any>;
const run = () => fetch(new URL('/api/run', srv.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-cv-agent': '1' }, body: JSON.stringify({ stage: 'tailor' }) });
const settled = async () => { for (let i = 0; i < 200; i++) { if (!(await get('/api/jobs')).run?.running) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('run never finished'); };

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agent-reload-'));
  configFile = path.join(tmp, 'agent.yaml');
  fs.cpSync('prompts', path.join(tmp, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'applied.txt'), '');
  writeConfig();
  ctx = await bootstrap(configFile, { quiet: true, fresh: true, now: () => new Date('2026-11-12T09:00:00Z') });
  srv = await startServer({ config: configFile, port: 0, ctx });
});
afterAll(async () => { await srv?.close(); await ctx?.close(); });

describe('reload', () => {
  it('re-reads edited prompts and keeps the open database', () => {
    const triage = path.join(tmp, 'prompts', `${ctx.cfg.llm.stages.triage.prompt}.md`);
    fs.appendFileSync(triage, '\n- An edited rule.\n');
    const next = ctx.reload!();
    expect(next.prompts.triage.hash).not.toBe(ctx.prompts.triage.hash);
    expect(next.prompts.triage.text).toContain('An edited rule.');
    expect(next.store).toBe(ctx.store);
    expect(next.llm).not.toBe(ctx.llm);
  });

  it('the dashboard starts each run from the config as it is now', async () => {
    expect((await get('/api/usage')).model).toBe(ctx.cfg.llm.stages.tailor.model);
    writeConfig('llm: { stages: { tailor: { model: test/edited-model } } }');
    expect((await run()).status).toBe(200);
    await settled();
    expect((await get('/api/usage')).model).toBe('test/edited-model');
  });

  it('refuses to start a run on a config it cannot use, and says why', async () => {
    writeConfig('llm: { stages: { triage: { temperature: hot } } }');
    let r = await run();
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/^Can't reload the settings: .*temperature/s);

    writeConfig('', 'other.db');
    r = await run();
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/paths\.db changed — restart/);
    writeConfig();
  });
});
