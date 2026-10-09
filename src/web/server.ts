import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyTo, type ApplyResult } from '../apply/apply.js';
import type { Asker } from '../apply/ask.js';
import type { Field } from '../apply/scan.js';
import { bootstrap } from '../bootstrap.js';
import type { Ctx } from '../ctx.js';
import { runPipeline, type RunOptions, type RunSummary } from '../pipeline/run.js';
import { manualVacancy } from '../sources/manual.js';
import { detectLang, sanitizeUntrusted } from '../util/text.js';
import { writeReport } from '../report.js';
import type { Status } from '../types.js';
import { localDay } from '../util/time.js';

/** A background job the page can watch: a pipeline run or one application. */
interface Job {
  kind: 'run' | 'apply';
  label: string;
  running: boolean;
  lines: string[];
  startedAt: string;
  /** apply only: the question the form is waiting on, answered from the page. */
  question: { id: number; label: string; options: string[]; required: boolean; pause?: boolean; link?: boolean } | null;
  result?: string;
  /** apply only: stops the attempt (closes the agent's window). */
  cancel?: () => void;
}

const MARKS: Record<string, Status> = { dismissed: 'dismissed', applied: 'applied', tailor: 'tailor_pending', triage: 'triage_pending' };

/**
 * Local dashboard: every vacancy the agent gathered, one-click assisted apply, runs and credits. Listens on
 * 127.0.0.1 only, and every write needs the page's own header, so another website can't drive it.
 */
export async function startServer(o: { config: string; port: number; open?: boolean; ctx?: Ctx }): Promise<{ url: string; close: () => Promise<void> }> {
  const ctx = o.ctx ?? await bootstrap(o.config, { allowMissingKey: true });
  const page = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const jobs: { run: Job | null; apply: Job | null } = { run: null, apply: null };
  let answer: ((v: string | null) => void) | null = null;
  let qid = 0;

  const say = (job: Job) => (line: string) => { job.lines.push(line); if (job.lines.length > 400) job.lines.splice(0, job.lines.length - 400); };

  /** The apply step's questions go to the page instead of the terminal. */
  const webAsker = (job: Job): Asker => ({
    question: (f: Field) => new Promise((resolve) => {
      job.question = { id: ++qid, label: f.label, options: f.options, required: f.required };
      answer = (v) => { job.question = null; answer = null; resolve(v); };
    }),
    pause: (message: string) => new Promise((resolve) => {
      job.question = { id: ++qid, label: message, options: [], required: false, pause: true };
      answer = () => { job.question = null; answer = null; resolve(); };
    }),
    link: (message: string) => new Promise((resolve) => {
      job.question = { id: ++qid, label: message, options: [], required: true, link: true };
      answer = (v) => { job.question = null; answer = null; resolve(v); };
    }),
    close: () => { answer?.(null); },
  });

  const vacancies = () => ctx.store.db.prepare(`SELECT id, source, url, title, company, location, status, status_reason, score,
      triage_json, pack_dir, posted_at, discovered_at, updated_at FROM vacancies WHERE status <> 'new' ORDER BY COALESCE(score, -1) DESC, discovered_at DESC`).all()
    .map((r: any) => {
      let t: any = {};
      try { t = JSON.parse(r.triage_json ?? '{}'); } catch { /* not screened */ }
      const files = r.pack_dir && fs.existsSync(r.pack_dir) ? fs.readdirSync(r.pack_dir) : [];
      const rel = r.pack_dir ? path.relative(path.resolve(ctx.cfg.paths.out, 'packs'), path.resolve(r.pack_dir)) : null;
      return {
        id: r.id, source: r.source, url: r.url, title: r.title, company: r.company, location: r.location,
        status: r.status, reason: r.status_reason, score: r.score, postedAt: r.posted_at, discoveredAt: r.discovered_at, updatedAt: r.updated_at,
        family: t.role_family ?? null, seniority: t.seniority ?? null, why: (t.matched_requirements ?? []).slice(0, 4), blockers: t.hard_blockers ?? [], salary: t.salary ?? null,
        pack: rel && !rel.startsWith('..') ? { dir: rel, files } : null,
      };
    });

  const usage = async () => {
    const q = (sql: string, ...a: unknown[]) => ctx.store.db.prepare(sql).get(...a) as { usd: number | null; calls: number };
    const today = localDay(new Date(), ctx.cfg.timezone);
    const byStage = ctx.store.db.prepare(`SELECT stage, COUNT(*) calls, ROUND(COALESCE(SUM(cost_usd),0),4) usd FROM llm_calls WHERE cache = 'miss' AND day LIKE ? GROUP BY stage`).all(`${today.slice(0, 7)}%`);
    let credits: { total: number; used: number } | null = null;
    const key = process.env[ctx.cfg.llm.apiKeyEnv];
    if (key && ctx.cfg.llm.baseUrl.includes('openrouter.ai')) {
      try {
        const r = await fetch('https://openrouter.ai/api/v1/credits', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
        const j = await r.json() as { data?: { total_credits: number; total_usage: number } };
        if (j.data) credits = { total: j.data.total_credits, used: j.data.total_usage };
      } catch { /* offline: local numbers only */ }
    }
    return {
      credits,
      today: q(`SELECT ROUND(COALESCE(SUM(cost_usd),0),4) usd, COUNT(*) calls FROM llm_calls WHERE cache = 'miss' AND day = ?`, today),
      month: q(`SELECT ROUND(COALESCE(SUM(cost_usd),0),4) usd, COUNT(*) calls FROM llm_calls WHERE cache = 'miss' AND day LIKE ?`, `${today.slice(0, 7)}%`),
      byStage, dailyBudget: ctx.cfg.llm.budget.dailyUsd, model: ctx.cfg.llm.stages.tailor.model,
      keySet: Boolean(key) || ctx.cfg.llm.provider === 'mock',
    };
  };

  const startRun = (label: string, opts: Pick<RunOptions, 'stage' | 'sources' | 'only' | 'manual'>): Job => {
    const job: Job = { kind: 'run', label, running: true, lines: [], startedAt: new Date().toISOString(), question: null };
    jobs.run = job;
    runPipeline(ctx, { ...opts, say: say(job), stop: { requested: false } })
      .then((s: RunSummary) => {
        const ready = s.packs.filter((p) => p.status === 'ready').length;
        writeReport(ctx, s);
        job.result = `${s.fresh} new · screened ${s.triaged.apply + s.triaged.borderline + s.triaged.reject + s.triaged.review} (${s.triaged.apply} to apply) · ${ready} CVs ready${s.pending.approve ? ` · ${s.pending.approve} shortlisted for your call` : ''}${s.stopped ? ` · stopped: ${s.stopped}` : ''}${s.sourceErrors.length ? ` · problems: ${s.sourceErrors.map((e) => e.source).join(', ')}` : ''}`;
      })
      .catch((e) => { job.result = `Failed: ${(e as Error).message}`; })
      .finally(() => { job.running = false; });
    return job;
  };

  const startApply = (id: string, simulate: boolean, force: boolean): Job => {
    const job: Job = { kind: 'apply', label: `${simulate ? 'Preview' : 'Apply'}: ${ctx.store.get(id)?.title ?? id}`, running: true, lines: [], startedAt: new Date().toISOString(), question: null };
    jobs.apply = job;
    const asker = webAsker(job);
    const control: { cancel?: () => void } = {};
    job.cancel = () => control.cancel?.();
    applyTo(ctx, id, { mode: simulate ? 'simulate' : 'assisted', ask: asker, out: say(job), force, control })
      .then((r: ApplyResult) => {
        job.result = r.status === 'applied' ? 'Submitted and marked applied.' : r.status === 'email' ? 'This job takes applications by email: a draft is open in your mail app — attach the CV and cover letter, send it, then press "I applied myself".' : r.status === 'simulated' ? `Preview ready: ${r.filled.length} fields filled, ${r.missing.length} left for you.` : `Browser closed without a confirmation page. ${r.filled.length} fields had been filled.`;
      })
      .catch((e) => { job.result = /nothing was submitted/.test((e as Error).message) ? (e as Error).message : `Failed: ${(e as Error).message}`; })
      .finally(() => { job.running = false; job.question = null; answer = null; });
    return job;
  };

  const send = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body as string | Buffer);
  };
  const readBody = (req: http.IncomingMessage): Promise<any> => new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 100_000) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    try {
      // Only this machine, only this page: blocks DNS-rebinding and cross-site requests.
      const host = (req.headers.host ?? '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'local only' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && req.headers['x-cv-agent'] !== '1') return send(res, 403, { error: 'missing page header' });

      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/vacancies') return send(res, 200, vacancies());
      if (req.method === 'GET' && url.pathname === '/api/usage') return send(res, 200, await usage());
      if (req.method === 'GET' && url.pathname === '/api/jobs') return send(res, 200, jobs); // functions (cancel) drop out of the JSON

      if (req.method === 'GET' && url.pathname.startsWith('/packs/')) {
        const root = path.resolve(ctx.cfg.paths.out, 'packs');
        const file = path.resolve(root, decodeURIComponent(url.pathname.slice('/packs/'.length)));
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
        const type = { '.pdf': 'application/pdf', '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }[path.extname(file)] ?? 'application/octet-stream';
        return send(res, 200, fs.readFileSync(file), type);
      }

      const mark = /^\/api\/vacancies\/([^/]+)\/(dismissed|applied|tailor|triage)$/.exec(url.pathname);
      if (req.method === 'POST' && mark) {
        const id = decodeURIComponent(mark[1]);
        const row = ctx.store.get(id);
        if (!row) return send(res, 404, { error: 'unknown vacancy' });
        // Restoring a LinkedIn-only vacancy with no text puts it back in its own tab, not the screening queue.
        const to = mark[2] === 'triage' && row.status === 'dismissed' && !row.text.trim() ? 'external' : MARKS[mark[2]];
        try {
          ctx.store.transition(id, to, `marked by hand: ${mark[2]}`, to.endsWith('_pending') ? { attempts: 0 } : {});
          if (to === 'applied') fs.appendFileSync(ctx.cfg.paths.appliedSeed, `${row.url}\n`);
        } catch (e) { return send(res, 409, { error: (e as Error).message }); }
        return send(res, 200, { ok: true });
      }
      const apply = /^\/api\/vacancies\/([^/]+)\/(apply|preview)$/.exec(url.pathname);
      if (req.method === 'POST' && apply) {
        if (jobs.apply?.running) return send(res, 409, { error: 'an application is already open — finish or close it first' });
        const body = await readBody(req);
        return send(res, 200, startApply(decodeURIComponent(apply[1]), apply[2] === 'preview', Boolean(body.force)));
      }
      if (req.method === 'POST' && url.pathname === '/api/apply/cancel') {
        if (!jobs.apply?.running) return send(res, 409, { error: 'no application open' });
        jobs.apply.cancel?.();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const body = await readBody(req);
        if (!answer) return send(res, 409, { error: 'no question waiting' });
        answer(typeof body.answer === 'string' && body.answer.trim() ? body.answer.trim() : null);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/run') {
        if (jobs.run?.running) return send(res, 409, { error: 'a run is already going' });
        const body = await readBody(req);
        if (!process.env[ctx.cfg.llm.apiKeyEnv] && ctx.cfg.llm.provider !== 'mock') return send(res, 400, { error: `${ctx.cfg.llm.apiKeyEnv} is not set in .env` });
        const sources = Array.isArray(body.sources) && body.sources.length ? body.sources.map(String) : undefined;
        const stage = body.stage === 'tailor' ? 'tailor' : undefined;
        return send(res, 200, startRun(stage ? 'Writing CVs for approved vacancies' : sources ? `Searching ${sources.join(', ')}` : 'Searching all sources', { stage, sources }));
      }
      // Posting text you pasted (LinkedIn & co): screen it and write the CV, for this vacancy only.
      const pasted = /^\/api\/vacancies\/([^/]+)\/text$/.exec(url.pathname);
      if (req.method === 'POST' && pasted) {
        if (jobs.run?.running) return send(res, 409, { error: 'a run is already going — try again when it finishes' });
        const id = decodeURIComponent(pasted[1]);
        const row = ctx.store.get(id);
        const body = await readBody(req);
        const text = sanitizeUntrusted(String(body.text ?? ''), ctx.cfg.pipeline.vacancyCharLimit);
        if (!row) return send(res, 404, { error: 'unknown vacancy' });
        if (text.length < 200) return send(res, 400, { error: 'paste the whole posting (at least a few paragraphs)' });
        ctx.store.setText(id, text, detectLang(`${row.title}\n${text}`));
        try { ctx.store.transition(id, 'triage_pending', 'marked by hand: pasted posting text', { attempts: 0 }); } catch (e) { return send(res, 409, { error: (e as Error).message }); }
        return send(res, 200, startRun(`Screening and writing: ${row.title}`, { only: [id] }));
      }
      if (req.method === 'POST' && url.pathname === '/api/add') {
        if (jobs.run?.running) return send(res, 409, { error: 'a run is already going — try again when it finishes' });
        const body = await readBody(req);
        const link = String(body.url ?? '').trim();
        if (!/^https?:\/\//i.test(link)) return send(res, 400, { error: 'paste the vacancy link (https://…)' });
        const text = typeof body.text === 'string' && body.text.trim().length >= 200 ? body.text : null;
        try {
          const raw = await manualVacancy(link, text, ctx.cfg);
          return send(res, 200, startRun(`Adding: ${raw.title.slice(0, 80)}`, { manual: [raw] }));
        } catch (e) { return send(res, 400, { error: (e as Error).message }); }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: (e as Error).message });
    }
  });

  await new Promise<void>((resolve) => server.listen(o.port, '127.0.0.1', resolve));
  const addr = server.address();
  const url = `http://localhost:${typeof addr === 'object' && addr ? addr.port : o.port}/`;
  if (o.open) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
  return {
    url,
    close: async () => { await new Promise<void>((r) => server.close(() => r())); if (!o.ctx) await ctx.close(); },
  };
}

// `npm start`
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = process.argv.includes('--config') ? process.argv[process.argv.indexOf('--config') + 1] : 'config/agent.yaml';
  const port = Number(process.env.CV_AGENT_PORT ?? 4870);
  startServer({ config, port, open: !process.argv.includes('--no-open') }).then(({ url }) => {
    console.log(`cv-agent dashboard: ${url}   (Ctrl+C to stop)`);
  }).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
}
