import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { ingest, runPipeline, type RunSummary } from '../src/pipeline/run.js';
import { buildReport } from '../src/report.js';

const blank = (): RunSummary => ({
  runId: 't', mode: 'dry-run', startedAt: '', finishedAt: '', discovered: 0, fresh: 0, filtered: {}, triaged: { apply: 0, reject: 0, review: 0 },
  packs: [], rejected: [], shortlisted: [], failed: 0, stopped: null, sourceErrors: [], pending: { triage: 0, approve: 0, tailor: 0 },
  failures: [], sameCompany: [], reposted: [], alertJobs: [], redecided: 0,
});

describe('a role posted again long after you applied', () => {
  it('screens a re-dated link and the same role under a new link again; a different role stays set aside', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agent-'));
    const appliedSeed = path.join(tmp, 'applied.txt');
    fs.writeFileSync(appliedSeed, [
      'https://jobs.dou.ua/companies/acme/vacancies/100/   # Acme 2026-08-01',
      'https://jobs.dou.ua/companies/acme/vacancies/101/   # Acme 2026-11-05',
      'https://jobs.dou.ua/companies/globex/vacancies/200/   # Globex 2026-08-01',
    ].join('\n'));
    const ctx = await bootstrap('config/demo.yaml', {
      quiet: true, fresh: true, now: () => new Date('2026-11-10T09:00:00Z'),
      overrides: { paths: { out: tmp, logs: path.join(tmp, 'logs'), db: path.join(tmp, 'state.db'), appliedSeed }, render: { engine: 'none' }, pipeline: { approveBeforeTailor: true } },
    });
    try {
      const raw = (id: string, company: string, title: string, postedAt: string) => ({ source: 't', url: `https://jobs.dou.ua/companies/${company.toLowerCase()}/vacancies/${id}/`, title, company, postedAt, descriptionText: 'Remote. TypeScript, Node.js.' });
      const s = blank();
      const appliedAt = new Map([['dou:100', '2026-08-01T12:00:00.000Z'], ['dou:101', '2026-11-05T12:00:00.000Z'], ['dou:200', '2026-08-01T12:00:00.000Z']]);
      const applied = new Set(appliedAt.keys());

      // First seen on its old date: set aside as applied. Then posted again 3 months later: it comes back as new.
      ingest(ctx, raw('200', 'Globex', 'Full-Stack Developer', '2026-07-30T10:00:00Z'), applied, s, appliedAt);
      expect(ctx.store.get('dou:200')).toMatchObject({ status: 'filtered', status_reason: 'already applied (tracking sheet)' });
      ingest(ctx, raw('200', 'Globex', 'Full-Stack Developer', '2026-11-09T10:00:00Z'), applied, s, appliedAt);
      expect(ctx.store.get('dou:200')).toMatchObject({ status: 'new', status_reason: 'reposted: you applied on 2026-08-01 (100 days ago)', posted_at: '2026-11-09T10:00:00Z' });
      // Applied 5 days ago: a newer date is a bump, not a repost.
      ingest(ctx, raw('101', 'Acme', 'Java Developer', '2026-11-09T10:00:00Z'), applied, s, appliedAt);
      expect(ctx.store.get('dou:101')?.status).toBe('filtered');

      // A new link for a role at Globex you applied to long ago: screened. A different role at Acme (applied 5 days ago): set aside.
      ingest(ctx, raw('201', 'Globex', 'Senior Full Stack Engineer', '2026-11-09T10:00:00Z'), applied, s, appliedAt);
      ingest(ctx, raw('102', 'Acme', 'Full-Stack Developer', '2026-11-09T10:00:00Z'), applied, s, appliedAt);

      const run = await runPipeline(ctx, { sources: ['t'] });
      expect(ctx.store.get('dou:102')).toMatchObject({ status: 'filtered', status_reason: expect.stringMatching(/^already applied to Acme/) });
      for (const id of ['dou:200', 'dou:201']) expect(ctx.store.get(id)?.status, id).not.toBe('filtered');
      expect(run.reposted.map((r) => r.id).sort()).toEqual(['dou:201']); // dou:200 was reported when it came in
      expect(buildReport(ctx, { ...run, reposted: [...s.reposted, ...run.reposted] })).toContain('Posted again long after you applied');

      // repostAfterDays: null turns it off: the old behaviour, set aside.
      ctx.cfg.pipeline.repostAfterDays = null;
      ingest(ctx, raw('202', 'Globex', 'Full-Stack Developer', '2026-11-09T10:00:00Z'), applied, s, appliedAt);
      await runPipeline(ctx, { sources: ['t'] });
      expect(ctx.store.get('dou:202')).toMatchObject({ status: 'filtered', status_reason: expect.stringMatching(/^already applied to Globex/) });
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
