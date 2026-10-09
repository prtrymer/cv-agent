import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { runPipeline } from '../src/pipeline/run.js';
import { buildReport } from '../src/report.js';

describe('dry run on fixtures', () => {
  it('with approveBeforeTailor, screening only shortlists: no CV until you say so', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agent-'));
    const ctx = await bootstrap('config/demo.yaml', {
      quiet: true, fresh: true, now: () => new Date('2026-09-22T09:00:00Z'),
      overrides: { paths: { out: tmp, logs: path.join(tmp, 'logs'), db: path.join(tmp, 'state.db') }, render: { engine: 'none' }, pipeline: { approveBeforeTailor: true } },
    });
    try {
      const s = await runPipeline(ctx);
      expect(s.triaged.apply).toBe(1);
      expect(s.packs).toHaveLength(0);
      expect(s.pending).toMatchObject({ approve: 1, tailor: 0 });
      const id = s.shortlisted[0].id;
      expect(ctx.store.get(id)?.status).toBe('shortlisted');
      expect(buildReport(ctx, s)).toContain('Shortlisted — your call');
      // A later run leaves it alone: nothing is written without your go.
      expect((await runPipeline(ctx)).packs).toHaveLength(0);

      ctx.store.transition(id, 'tailor_pending', 'marked by hand: tailor');
      const written = await runPipeline(ctx, { stage: 'tailor' });
      expect(written.packs.map((p) => [p.id, p.status])).toEqual([[id, 'ready']]);
      expect(written.pending.approve).toBe(0);

      // A vacancy you add yourself is already your pick: screened and written in one go.
      const added = await runPipeline(ctx, { manual: [{ source: 'manual', url: 'https://djinni.co/jobs/900002-senior-backend-engineer-kotlin/', title: 'Senior Backend Engineer (Kotlin)' }] });
      expect(added.shortlisted).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('walks a vacancy from feed to application pack', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-agent-'));
    const ctx = await bootstrap('config/demo.yaml', {
      quiet: true,
      fresh: true,
      now: () => new Date('2026-09-22T09:00:00Z'),
      overrides: { paths: { out: tmp, logs: path.join(tmp, 'logs'), db: path.join(tmp, 'state.db') }, render: { engine: 'none' } },
    });
    try {
      const s = await runPipeline(ctx);
      expect(s.discovered).toBe(6);
      expect(s.fresh).toBe(6);
      expect(s.filtered['already applied']).toBe(1);
      expect(s.triaged.apply).toBe(1);
      expect(s.triaged.reject).toBe(1);
      expect(s.packs).toHaveLength(1);

      const pack = s.packs[0];
      expect(pack.status).toBe('ready');
      expect(pack.issues).toEqual([]);
      for (const f of ['Anton_Chaika_CV.html', 'Anton_Chaika_Cover_Letter.docx', 'cover_letter.txt', 'vacancy.md', 'decision.json']) {
        expect(fs.existsSync(path.join(pack.dir, f)), f).toBe(true);
      }
      const letter = fs.readFileSync(path.join(pack.dir, 'cover_letter.txt'), 'utf8');
      expect(letter.startsWith('Hi!')).toBe(true);
      expect(letter.trim().endsWith('Anton Chaika')).toBe(true);
      expect(letter).toContain('CV attached');

      const html = fs.readFileSync(path.join(pack.dir, 'Anton_Chaika_CV.html'), 'utf8');
      expect(html).toContain('ANTON CHAIKA');
      expect(html).not.toContain('Fly.io');
      expect(html).toContain('Coolbet');

      expect(buildReport(ctx, s)).toContain('Ready for you');

      // Rerunning finds nothing new and spends nothing.
      const again = await runPipeline(ctx);
      expect(again.fresh).toBe(0);
      expect(again.packs).toHaveLength(0);

      // `add` handles only what it was given: a queued backlog vacancy is left for the next run.
      ctx.store.insertIfNew({ id: 'dou:999999', source: 'dou-demo', url: 'https://jobs.dou.ua/companies/x/vacancies/999999/', title: 'Full-Stack Developer', company: 'X', location: null, text: 'remote', lang: 'en', posted_at: null, status: 'triage_pending', status_reason: null });
      const added = await runPipeline(ctx, { manual: [{ source: 'manual', url: 'https://djinni.co/jobs/900002-senior-backend-engineer-kotlin/', title: 'Senior Backend Engineer (Kotlin)' }] });
      expect(added.triaged).toEqual({ apply: 0, borderline: 0, reject: 0, review: 0 });
      expect(ctx.store.get('dou:999999')?.status).toBe('triage_pending');

      // `--source alerts` screens only alert vacancies: the queued DOU one waits, and "alerts are off" is reported.
      const alertsOnly = await runPipeline(ctx, { sources: ['alerts'] });
      expect(alertsOnly.triaged).toEqual({ apply: 0, borderline: 0, reject: 0, review: 0 });
      expect(ctx.store.get('dou:999999')?.status).toBe('triage_pending');
      expect(alertsOnly.sourceErrors).toEqual([expect.objectContaining({ source: 'alerts', error: expect.stringMatching(/alerts are off|alert emails are off/) })]);

      // A new role at a company you already applied to is set aside before any model call — until you send it on.
      ctx.store.insertIfNew({ id: 'dou:777777', source: 'dou-demo', url: 'https://jobs.dou.ua/companies/zerotasklabs/vacancies/777777/', title: 'Senior Full-Stack Developer', company: 'Zero Task Labs', location: 'remote', text: 'remote', lang: 'en', posted_at: null, status: 'triage_pending', status_reason: null });
      const same = await runPipeline(ctx, { sources: ['dou-demo'] });
      expect(ctx.store.get('dou:777777')).toMatchObject({ status: 'filtered', status_reason: 'already applied to zerotasklabs: https://jobs.dou.ua/companies/zerotasklabs/vacancies/372338/' });
      expect(same.sameCompany.map((c) => c.id)).toEqual(['dou:777777']);
      expect(buildReport(ctx, same)).toContain('Set aside: you already applied to this company');
      ctx.store.transition('dou:777777', 'triage_pending', 'marked by hand: triage');
      await runPipeline(ctx, { sources: ['dou-demo'] });
      expect(ctx.store.get('dou:777777')?.status).not.toBe('filtered');

      // A posting older than maxAgeDays is skipped before any model call.
      ctx.store.insertIfNew({ id: 'dou:888888', source: 'dou-demo', url: 'https://jobs.dou.ua/companies/x/vacancies/888888/', title: 'Java Developer', company: 'X', location: null, text: 'remote', lang: 'en', posted_at: 'Mon, 24 Aug 2026 10:00:00 +0300', status: 'triage_pending', status_reason: null });
      const aged = await runPipeline(ctx, { sources: ['dou-demo'] });
      expect(ctx.store.get('dou:888888')).toMatchObject({ status: 'filtered', status_reason: 'posted 29 days ago' });
      expect(aged.filtered['too old']).toBe(1);
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
