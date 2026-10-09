import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { runPipeline, type RunSummary } from './pipeline/run.js';
import { rendererBinary } from './render/cv.js';
import { applyTo } from './apply/apply.js';
import { terminalAsker } from './apply/ask.js';
import { writeReport } from './report.js';
import { manualVacancy } from './sources/manual.js';
import { loadWatchlist } from './sources/watchlist.js';
import { Store, type VacancyRow } from './store/db.js';
import type { Status } from './types.js';
import { canonicalize } from './util/url.js';
import { isWorkingTime } from './util/time.js';

const USAGE = `cv-agent
  run [--config f] [--source id]... [--stage tailor] [--fresh]
                                                discover → prefilter → triage → tailor → packs + report
                                                (--stage tailor: only write packs for already approved vacancies)
  review                                        go through the shortlisted vacancies: write a CV, dismiss or skip each
  add <url> [--file posting.txt]                one vacancy from anywhere (paste the text for LinkedIn/Glassdoor)
  apply [<url|id>] [--simulate] [--force] [--url form-link]
                                                fill a ready pack's application form; you review and press Submit
                                                (no argument: list the ready packs)
  mark <url|id> <applied|dismissed|tailor|triage>
                                                record what you did, or send a vacancy back through the pipeline
  report                                        print the latest report
  doctor                                        check config, data files, renderer, cache, working hours`;

const MARKS: Record<string, Status> = { applied: 'applied', dismissed: 'dismissed', tailor: 'tailor_pending', triage: 'triage_pending' };

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'config/agent.yaml' },
      source: { type: 'string', multiple: true },
      file: { type: 'string' },
      fresh: { type: 'boolean', default: false },
      simulate: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      url: { type: 'string' },
      stage: { type: 'string' },
    },
  });
  const [command, arg, arg2] = positionals;
  const configPath = values.config as string;

  if (!command || command === 'help') { console.log(USAGE); return 0; }

  if (command === 'report') {
    const file = path.join(loadConfig(configPath).paths.out, 'latest-report.md');
    console.log(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'no report yet — run `npm run run` first');
    return 0;
  }

  if (command === 'mark') {
    const to = MARKS[arg2 ?? ''];
    if (!arg || !to) { console.error(`usage: mark <url|id> <${Object.keys(MARKS).join('|')}>`); return 2; }
    const cfg = loadConfig(configPath);
    const store = new Store(cfg.paths.db);
    try {
      const id = /^https?:\/\//i.test(arg) ? canonicalize(arg)?.key : arg;
      const row = id ? store.get(id) : undefined;
      if (!row) { console.error(`no vacancy ${id ?? arg} in ${cfg.paths.db} — use \`add <url>\` for one the agent hasn't seen`); return 1; }
      store.transition(row.id, to, `marked by hand: ${arg2}`, to === 'tailor_pending' || to === 'triage_pending' ? { attempts: 0 } : {});
      console.log(`${row.id}: ${row.status} → ${to}${to.endsWith('_pending') ? ' (picked up by the next run)' : ''}`);
      return 0;
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    } finally {
      store.close();
    }
  }

  if (command === 'review') return review(configPath);

  if (command === 'apply') {
    const ctx = await bootstrap(configPath, { quiet: true });
    try {
      if (!arg) {
        const ready = ctx.store.byStatus(['ready']);
        console.log(ready.length
          ? `Ready to apply (npm run apply -- <id>):\n${ready.map((r) => `  ${r.id.padEnd(34)} ${r.score ?? '—'}  ${r.title}${r.company ? ` · ${r.company}` : ''}`).join('\n')}`
          : 'No ready packs — run `npm run run` first, or check "Needs your review" in the report.');
        return 0;
      }
      const id = /^https?:\/\//i.test(arg) ? canonicalize(arg)?.key ?? arg : arg;
      const ask = terminalAsker();
      try {
        const r = await applyTo(ctx, id, {
          mode: values.simulate ? 'simulate' : ctx.cfg.apply.mode, ask, out: (l) => console.log(l),
          force: values.force as boolean, url: values.url as string | undefined,
        });
        console.log(`\n${r.status}: ${r.filled.length} fields filled, ${r.missing.length} left for you. Screenshot and answers: ${r.dir}`);
        return 0;
      } finally {
        ask.close();
      }
    } finally {
      await ctx.close();
    }
  }

  if (command === 'doctor') {
    const ctx = await bootstrap(configPath, { quiet: true, allowMissingKey: true });
    const wh = isWorkingTime(ctx.now(), ctx.cfg.workingHours, ctx.cfg.timezone);
    const r = rendererBinary(ctx.cfg.render);
    const renderer = ctx.cfg.render.engine === 'none' ? 'none (HTML only)' : r.bin ? `${ctx.cfg.render.engine} at ${r.bin}` : `MISSING — ${ctx.cfg.render.engine} not found (looked for ${r.tried.join(', ')})`;
    console.log([
      `config      ${configPath} (mode: ${ctx.cfg.mode})`,
      `profile     ${ctx.k.engagements.size} engagements, ${ctx.k.bullets.size} bullets, ${ctx.k.totalYears} years total`,
      `answers     ${ctx.k.location.commuteCities.join(', ') || 'no commute cities set'}`,
      `prompts     triage ${ctx.prompts.triage.version}#${ctx.prompts.triage.hash} · tailor ${ctx.prompts.tailor.version}#${ctx.prompts.tailor.hash}`,
      `model       ${ctx.cfg.llm.stages.triage.model} (${ctx.cfg.llm.provider}) at ${ctx.cfg.llm.baseUrl}`,
      `api key     ${ctx.cfg.llm.provider === 'mock' ? 'not needed (mock)' : process.env[ctx.cfg.llm.apiKeyEnv] ? 'set' : `MISSING (${ctx.cfg.llm.apiKeyEnv})`}`,
      `cache       ${ctx.cache.kind}`,
      `renderer    ${renderer}`,
      `sources     ${ctx.cfg.sources.filter((s) => s.enabled).map((s) => s.id).join(', ')}`,
      `watchlist   ${ctx.cfg.paths.watchlist ? `${loadWatchlist(ctx.cfg.paths.watchlist).length} companies (${ctx.cfg.paths.watchlist})` : 'off'}`,
      `alerts      ${ctx.cfg.alerts.enabled ? `on — ${ctx.cfg.alerts.host} ${ctx.cfg.alerts.mailbox}, ${process.env[ctx.cfg.alerts.userEnv] && process.env[ctx.cfg.alerts.passwordEnv] ? 'credentials set' : `MISSING ${ctx.cfg.alerts.userEnv}/${ctx.cfg.alerts.passwordEnv}`}` : 'off (alerts.enabled in config)'}`,
      `apply       ${ctx.cfg.apply.mode}, browser profile ${ctx.cfg.apply.browserProfile}`,
      `right now   ${wh.ok ? 'inside working hours' : `outside working hours (${wh.reason})`}`,
    ].join('\n'));
    await ctx.close();
    return 0;
  }

  if (command === 'run' || command === 'add') {
    const ctx = await bootstrap(configPath, { fresh: values.fresh as boolean });
    try {
      if (ctx.cfg.mode === 'live') {
        console.error('live mode is not wired yet (sheet + submitters are the next phase) — keep mode: dry-run');
        return 2;
      }
      let manual;
      if (command === 'add') {
        if (!arg) { console.error('usage: add <url> [--file posting.txt]'); return 2; }
        const pasted = values.file ? fs.readFileSync(values.file as string, 'utf8') : null;
        manual = [await manualVacancy(arg, pasted, ctx.cfg)];
      }
      if (values.stage && values.stage !== 'tailor') { console.error('--stage takes: tailor'); return 2; }
      const stop = { requested: false };
      process.once('SIGINT', () => {
        stop.requested = true;
        console.log('\nStopping after the calls in progress (a few seconds)… press Ctrl+C again to quit at once.');
        process.once('SIGINT', () => process.exit(130));
      });
      const summary = await runPipeline(ctx, {
        sources: values.source as string[] | undefined, manual, stage: values.stage as 'tailor' | undefined, stop, say: (l) => console.log(l),
      });
      console.log(doneLines(summary, writeReport(ctx, summary)).join('\n'));
      return summary.failed > 0 || summary.sourceErrors.length > 0 ? 1 : 0;
    } finally {
      await ctx.close();
    }
  }

  console.error(`unknown command "${command}"\n\n${USAGE}`);
  return 2;
}

function doneLines(summary: RunSummary, file: string): string[] {
  const ready = summary.packs.filter((p) => p.status === 'ready').length;
  return [
    '',
    `Done: ${summary.fresh} new · screened ${summary.triaged.apply + summary.triaged.borderline + summary.triaged.reject + summary.triaged.review} (apply ${summary.triaged.apply}, borderline ${summary.triaged.borderline}) · packs ${ready} ready, ${summary.packs.length - ready} to review · failed ${summary.failed}`,
    ...(summary.stopped ? [`Stopped: ${summary.stopped}`] : []),
    ...(summary.pending.approve ? [`Waiting for your go: ${summary.pending.approve} shortlisted — npm run review   (or the dashboard: npm start)`] : []),
    ...(summary.pending.triage || summary.pending.tailor ? [`Waiting for the next run: ${summary.pending.triage} to screen, ${summary.pending.tailor} to write`] : []),
    ...summary.sourceErrors.map((e) => `Problem — ${e.source}: ${e.error}`),
    `Report: ${file}  (also out/latest-report.md, or: npm run report)`,
    ...(ready ? ['Apply: npm run apply   (lists the ready packs)'] : []),
  ];
}

/** One shortlisted vacancy, as much as you need to decide: score, where, what fits, what might not. */
function describe(row: VacancyRow, i: number, n: number): string {
  let t: { role_family?: string; seniority?: string; matched_requirements?: string[]; hard_blockers?: string[]; salary?: string | null } = {};
  try { t = JSON.parse(row.triage_json ?? '{}'); } catch { /* not screened */ }
  return [
    '',
    `[${i}/${n}]  ${row.score ?? '—'}  ${row.title}${row.company ? ` · ${row.company}` : ''}`,
    `      ${[row.location, t.role_family, t.seniority, t.salary].filter(Boolean).join(' · ')}`,
    ...(t.matched_requirements?.length ? [`      fits: ${t.matched_requirements.slice(0, 4).join('; ')}`] : []),
    ...(t.hard_blockers?.length ? [`      but:  ${t.hard_blockers.join('; ')}`] : []),
    `      ${row.url}`,
  ].join('\n');
}

/** `review`: say which shortlisted vacancies get a CV. Approved ones can be written right away. */
async function review(configPath: string): Promise<number> {
  const cfg = loadConfig(configPath);
  const store = new Store(cfg.paths.db);
  let approved = 0;
  try {
    const rows = store.byStatus(['shortlisted']).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    if (!rows.length) { console.log('Nothing shortlisted — run `npm run run` to screen new vacancies.'); return 0; }
    if (!process.stdin.isTTY) {
      console.log(`${rows.map((r, i) => describe(r, i + 1, rows.length)).join('\n')}\n\nWrite a CV: npm run mark -- <id> tailor · drop one: npm run mark -- <id> dismissed`);
      return 0;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let dismissed = 0;
    try {
      for (const [i, row] of rows.entries()) {
        console.log(describe(row, i + 1, rows.length));
        let key = '';
        while (!['w', 'd', 's', 'q'].includes(key)) key = (await rl.question('      w = write CV · d = dismiss · s = skip · q = stop  > ')).trim().toLowerCase().slice(0, 1);
        if (key === 'q') break;
        if (key === 'w') { store.transition(row.id, 'tailor_pending', 'marked by hand: tailor', { attempts: 0 }); approved++; }
        if (key === 'd') { store.transition(row.id, 'dismissed', 'marked by hand: dismissed'); dismissed++; }
      }
      const left = store.byStatus(['shortlisted']).length;
      console.log(`\n${approved} to write, ${dismissed} dismissed, ${left} still shortlisted.`);
      const queued = store.byStatus(['tailor_pending']).length;
      if (!queued) return 0;
      const now = (await rl.question(`Write ${queued > cfg.pipeline.maxTailorPerRun ? `${cfg.pipeline.maxTailorPerRun} of the ${queued}` : `the ${queued}`} CV${queued === 1 ? '' : 's'} now? [Y/n] `)).trim().toLowerCase();
      if (now.startsWith('n')) { console.log('Later: npm run run -- --stage tailor'); return 0; }
    } finally { rl.close(); }
  } finally { store.close(); }

  const ctx = await bootstrap(configPath, {});
  try {
    const summary = await runPipeline(ctx, { stage: 'tailor', say: (l) => console.log(l) });
    console.log(doneLines(summary, writeReport(ctx, summary)).join('\n'));
    return summary.failed > 0 ? 1 : 0;
  } finally { await ctx.close(); }
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
