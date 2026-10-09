import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './ctx.js';
import type { RunSummary } from './pipeline/run.js';

const money = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(4)}`);
const rel = (ctx: Ctx, p: string): string => path.relative(process.cwd(), p) || p;

/** The dry-run log: what was seen, what was decided and what it cost. */
export function buildReport(ctx: Ctx, s: RunSummary): string {
  const usage = ctx.store.usageForRun(s.runId);
  const out: string[] = [];
  out.push(`# cv-agent run — ${s.startedAt.slice(0, 16).replace('T', ' ')} (${s.mode}${ctx.cfg.llm.provider === 'mock' ? ', mock model' : ''})`, '');
  out.push(`Discovered ${s.discovered} · new ${s.fresh} · filtered ${Object.values(s.filtered).reduce((a, b) => a + b, 0)} · triaged ${s.triaged.apply + s.triaged.borderline + s.triaged.reject + s.triaged.review} (apply ${s.triaged.apply} · borderline ${s.triaged.borderline} · reject ${s.triaged.reject} · review ${s.triaged.review}) · packs ${s.packs.filter((p) => p.status === 'ready').length} ready, ${s.packs.filter((p) => p.status !== 'ready').length} needs review · failed ${s.failed}`, '');
  if (s.stopped) out.push(`> Stopped early: ${s.stopped}`, '');

  const ready = s.packs.filter((p) => p.status === 'ready');
  if (ready.length) {
    out.push('## Ready for you', '', '| Score | Role | Company | Why it fits | Pack |', '| --- | --- | --- | --- | --- |');
    for (const p of ready) out.push(`| ${p.score ?? '—'} | [${p.title}](${p.url}) | ${p.company ?? '—'} | ${p.why.slice(0, 3).join('; ')} | \`${rel(ctx, p.dir)}\` |`);
    out.push('');
  }
  const review = s.packs.filter((p) => p.status !== 'ready');
  if (review.length) {
    out.push('## Needs your review', '', '| Role | Company | Why | Pack |', '| --- | --- | --- | --- |');
    for (const p of review) out.push(`| [${p.title}](${p.url}) | ${p.company ?? '—'} | ${p.issues.join('; ')} | \`${rel(ctx, p.dir)}\` |`);
    out.push('');
  }
  if (s.shortlisted.length) {
    out.push('## Shortlisted — your call before any CV is written', '', 'Go through them: `npm run review` (or the dashboard, `npm start`).', '',
      '| Score | Role | Company | Id |', '| --- | --- | --- | --- |');
    for (const b of s.shortlisted) out.push(`| ${b.score ?? '—'} | [${b.title}](${b.url}) | ${b.company ?? '—'} | \`${b.id}\` |`);
    out.push('');
  }
  if (s.borderline.length) {
    out.push('## Borderline (your call)', '', '| Score | Role | Company | Note |', '| --- | --- | --- | --- |');
    for (const b of s.borderline) out.push(`| ${b.score ?? '—'} | [${b.title}](${b.url}) | ${b.company ?? '—'} | ${b.reason} |`);
    out.push('');
  }
  if (s.rejected.length) {
    out.push('## Rejected (tuning log)', '', '| Score | Role | Company | Reason |', '| --- | --- | --- | --- |');
    for (const r of s.rejected) out.push(`| ${r.score ?? '—'} | [${r.title}](${r.url}) | ${r.company ?? '—'} | ${r.reason} |`);
    out.push('');
  }
  if (s.sameCompany.length) {
    out.push('## Set aside: you already applied to this company', '', 'To apply anyway: `npm run mark -- <id> triage`.', '', '| Role | Company | Earlier application | Id |', '| --- | --- | --- | --- |');
    for (const c of s.sameCompany) out.push(`| [${c.title}](${c.url}) | ${c.company ?? '—'} | ${c.earlier} | \`${c.id}\` |`);
    out.push('');
  }
  if (s.unresolved.length) {
    out.push('## In your alerts, not on a company board', '', 'Apply on LinkedIn/Glassdoor yourself, or save the posting text and run `add <url> --file posting.txt`.', '',
      '| Role | Company | Location | Why |', '| --- | --- | --- | --- |');
    for (const u of s.unresolved) out.push(`| [${u.title}](${u.url}) | ${u.company} | ${u.location ?? '—'} | ${u.reason} |`);
    out.push('');
  }
  const filtered = Object.entries(s.filtered).sort((a, b) => b[1] - a[1]);
  if (filtered.length) {
    out.push('## Filtered before any model call', '', ...filtered.map(([reason, n]) => `- ${reason}: ${n}`), '');
  }
  if (usage.length) {
    out.push('## Model usage', '', '| Stage | Calls | Cache hits | Input | Cached input | Output | Cost | Avg latency | Not-ok |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const u of usage) out.push(`| ${u.stage} | ${u.calls} | ${u.hits} | ${u.input} | ${u.cached} | ${u.output} | ${money(u.cost)} | ${u.latency ? `${Math.round(u.latency)} ms` : '—'} | ${u.bad} |`);
    const priced = ctx.cfg.llm.pricing.inputPerM !== null && ctx.cfg.llm.pricing.outputPerM !== null;
    out.push('', `Cache: ${ctx.cache.kind}.${priced ? '' : ' Prices are unset in config, so cost shows only when the provider reports it.'}`, '');
  }
  if (s.pending.approve) out.push(`Shortlisted, waiting for your go: ${s.pending.approve} in all.`, '');
  if (s.pending.triage || s.pending.tailor) out.push(`Still queued for the next run: ${s.pending.triage} to triage, ${s.pending.tailor} to tailor.`, '');
  if (s.failures.length) {
    out.push('## Failed this run (retried next run)', '', ...s.failures.map((f) => `- ${f}`), '');
  }
  if (s.sourceErrors.length) {
    out.push('## Source errors', '', ...s.sourceErrors.map((e) => `- ${e.source}: ${e.error}`), '');
  }
  return out.join('\n');
}

export function writeReport(ctx: Ctx, s: RunSummary): string {
  const dir = path.join(ctx.cfg.paths.out, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${s.runId}.md`);
  const text = buildReport(ctx, s);
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(ctx.cfg.paths.out, 'latest-report.md'), text);
  return file;
}
