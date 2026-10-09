import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { Ctx } from '../ctx.js';
import { appliedEntries, packFileNames } from '../pipeline/run.js';
import { appliedCompanies, sameCompanyAs } from '../pipeline/applied.js';
import { htmlToPdf } from '../render/cv.js';
import { extractJobPosting } from '../sources/manual.js';
import { politeFetch } from '../util/http.js';
import { canonicalize } from '../util/url.js';
import { learnedAnswer, loadLearned, ruleAnswer, saveLearned, toField, type Answer, type Facts } from './answers.js';
import type { Asker } from './ask.js';
import { attachDjinniCv, DJINNI_CV_SELECT } from './djinni.js';
import { fillField, highlight } from './fill.js';
import { botWallMessage, onProtectedBoard, openInYourBrowser, resolveApplyLink, waitOutBotWall } from './gate.js';
import { forModel, modelAnswers } from './model.js';
import { scanForm, type Field } from './scan.js';

export interface ApplyOptions {
  mode: 'assisted' | 'simulate';
  ask: Asker;
  out: (line: string) => void;
  /** Apply to a needs_review pack too (after you've checked it). */
  force?: boolean;
  /** Open this page instead of the posting's own form (a form link you found yourself; tests). */
  url?: string;
  /** Filled in by applyTo: stops the attempt from outside (the dashboard's Cancel). */
  control?: { cancel?: () => void };
  /** Opens a page in your own browser or mail app (tests replace it). */
  openExternal?: (url: string) => void;
}
export interface ApplyResult {
  /** email: the job takes applications by email — a draft was opened in your mail app instead of a form. */
  status: 'applied' | 'filled' | 'simulated' | 'email';
  filled: Array<{ label: string; value: string; source: Answer['source'] }>;
  missing: string[];
  errors: string[];
  dir: string;
}

/** Where each ATS keeps the application form for a posting URL. */
export function applyUrl(url: string): string {
  const key = canonicalize(url)?.key ?? '';
  if (key.startsWith('lever:')) return url.replace(/\/?$/, '/apply');
  if (key.startsWith('ashby:')) return url.replace(/\/?$/, '/application');
  if (key.startsWith('workable:')) return url.replace(/\/?$/, '/apply/');
  if (key.startsWith('recruitee:')) return url.replace(/\/?$/, '/c/new');
  return url;
}

const FORM = 'input[type="file"], input[type="email"], textarea, [contenteditable="true"]';
/** Buttons that open an application form (never the final submit, never "Apply with LinkedIn"). */
const APPLY_BUTTON = /^\s*(apply( now)?( for (this|the) (job|position|role))?|відгукнутися( на вакансію)?|откликнуться( на вакансию)?|подати (заявку|резюме)|reagovat|odpovědět)\s*$/i;
const LOGGED_OUT = '#relogin-link, a[href*="/login"], a[href*="signin"], a[href*="sign-in"]';

/**
 * Gets the application form onto the screen. Company ATS pages show it straight away; job boards like DOU and Djinni
 * need you logged in (asked once — the agent's browser remembers) and a click on "Відгукнутися" / "Apply", which the
 * agent does itself. If none of that works it asks you to open the form by hand.
 */
export async function openForm(page: Page, target: string, o: ApplyOptions): Promise<Page> {
  const context = page.context();
  const hasForm = (p: Page) => p.waitForSelector(FORM, { timeout: 8_000, state: 'visible' }).then(() => true, () => false);
  let current = page;
  await passBotWall(current, o);
  if (await hasForm(current)) return current;
  for (let attempt = 0; attempt < 3; attempt++) {
    // DOU marks a logged-out page with #relogin-link; elsewhere a login URL gives it away.
    const loggedOut = await current.locator('#relogin-link').count() > 0 || /login|signin|sign-in|auth/i.test(current.url());
    if (loggedOut) {
      if (o.mode === 'simulate') return current;
      await o.ask.pause(`Log in to ${new URL(current.url()).hostname || new URL(target).hostname} in the agent's browser window — it remembers you from then on — then press Continue.`);
      await current.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      if (await hasForm(current)) return current;
      continue;
    }
    const button = current.locator('a:visible, button:visible').filter({ hasText: APPLY_BUTTON }).filter({ hasNotText: /linkedin|indeed|google|xing|seznam/i }).first();
    if (!(await button.count())) break;
    // Job boards often send you to the company's own form in a new tab (DOU → PeopleForce, Workable…): follow it.
    const popup = context.waitForEvent('page', { timeout: 4_000 }).catch(() => null);
    await button.click({ timeout: 5_000 }).catch(() => {});
    const opened = await popup;
    if (opened) {
      await opened.waitForLoadState('domcontentloaded').catch(() => {});
      await opened.bringToFront().catch(() => {});
      current = opened;
    } else {
      await current.waitForLoadState('domcontentloaded').catch(() => {});
    }
    await passBotWall(current, o);
    if (await hasForm(current)) return current;
    if (!opened && !(await current.locator(LOGGED_OUT).count()) && !/login|signin|auth/i.test(current.url())) break;
  }
  if (o.mode === 'assisted') {
    await o.ask.pause('Open the application form in the agent\'s browser window (click "Apply" / "Відгукнутися"), then press Continue.');
    return formPage(context, current);
  }
  return current;
}

/**
 * A bot-check page (Cloudflare "Just a moment…") is waited out for a few seconds in case it clears by itself. If it
 * doesn't, the attempt stops and the page goes to your own browser: the agent never tries to get past the check.
 */
async function passBotWall(page: Page, o: ApplyOptions): Promise<void> {
  if (await waitOutBotWall(page)) return;
  const url = page.url();
  if (o.mode === 'assisted') (o.openExternal ?? openInYourBrowser)(url);
  throw new Error(botWallMessage(url, o.mode === 'assisted'));
}

/** The tab that holds the form — newest first — in case it was opened by hand in another tab. */
async function formPage(context: BrowserContext, fallback: Page): Promise<Page> {
  for (const p of [...context.pages()].reverse()) {
    if (!p.isClosed() && await p.locator(FORM).count().catch(() => 0)) return p;
  }
  return fallback;
}

// Djinni sends you back to the job page with ?applied=ok once the reply is sent.
const CONFIRM_URL = /confirm|thank|success|submitted|application-sent|\/done\b|[?&]applied=ok\b/i;
const CONFIRM_TEXT = /thank(s| you) for (applying|your (application|interest))|application (has been |was )?(submitted|received|sent)|we('ve| have) received your application|successfully (applied|submitted)/i;
const show = (v: Answer['value']): string => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? '☑' : '☐') : v.length > 90 ? `${v.slice(0, 87)}…` : v);

/**
 * Fills one company application form from a ready pack. Assisted mode leaves the browser open for you to review and
 * press Submit, then marks the vacancy applied once the confirmation page appears. Nothing here ever submits.
 */
export async function applyTo(ctx: Ctx, id: string, o: ApplyOptions): Promise<ApplyResult> {
  const row = ctx.store.get(id);
  if (!row) throw new Error(`no vacancy ${id}`);
  if (row.status !== 'ready' && !(o.force && row.status === 'needs_review')) {
    throw new Error(`${id} is ${row.status}; only ready packs are applied to${row.status === 'needs_review' ? ' (check the pack, then --force)' : ''}`);
  }
  if (!row.pack_dir || !fs.existsSync(row.pack_dir)) throw new Error(`${id} has no pack folder — run the pipeline first`);
  // Djinni's feed never names the company: read it off the job page, or an earlier application there goes unnoticed.
  if (!row.company && /^https:\/\/djinni\.co\/jobs\//.test(row.url)) {
    const company = await politeFetch(row.url, ctx.cfg.http).then((r) => extractJobPosting(r.text)?.company ?? null, () => null);
    if (company) { ctx.store.setCompany(row.id, company); row.company = company; }
  }
  const earlier = sameCompanyAs(await appliedCompanies(ctx, appliedEntries(ctx)), row);
  if (earlier && !o.force) throw new Error(`you already applied to ${earlier.name}: ${earlier.link} — add --force to apply to ${row.company ?? 'them'} again`);

  const names = packFileNames(ctx.k.profile.person.name);
  const cv = path.join(row.pack_dir, names.cvPdf);
  if (!fs.existsSync(cv)) {
    const r = await htmlToPdf(path.join(row.pack_dir, names.cvHtml), cv, { ...ctx.cfg.render, engine: 'playwright' });
    if (r.error) throw new Error(`the CV PDF is missing and could not be rendered: ${r.error}`);
  }
  const facts: Facts = {
    k: ctx.k,
    vacancy: { url: row.url, source: row.source, title: row.title, company: row.company },
    files: { cv, letterDocx: path.join(row.pack_dir, names.letterDocx), letterText: fs.readFileSync(path.join(row.pack_dir, 'cover_letter.txt'), 'utf8') },
    learned: loadLearned(ctx.cfg.paths.answers),
  };

  // Boards like We Work Remotely: their page never goes in the agent's window, only the form "Apply" leads to.
  let target = o.url ?? applyUrl(row.url);
  if (onProtectedBoard(row.url, ctx.cfg.apply.protectedBoards)) {
    if (o.url) ctx.store.applyLinkSet(row.id, o.url, 'you (--url)');
    else {
      if (o.control) o.control.cancel = () => o.ask.close();
      const link = await resolveApplyLink(ctx, row, { mode: o.mode, ask: o.ask, out: o.out, openExternal: o.openExternal ?? openInYourBrowser });
      if (!link) {
        throw new Error(o.mode === 'simulate'
          ? `${row.id} needs its apply link first: run Apply once (not the preview) and paste where "Apply now" leads — nothing was submitted`
          : 'No apply link — nothing was submitted');
      }
      if (link.kind === 'email') return emailApplication(ctx, row, facts, link.address, o);
      target = applyUrl(link.url);
    }
  }

  const { chromium } = await import('playwright');
  const context: BrowserContext = o.mode === 'simulate'
    ? await (await chromium.launch()).newContext()
    : await chromium.launchPersistentContext(ctx.cfg.apply.browserProfile, { headless: false, viewport: null });
  const closeAll = async () => { const b = context.browser(); await context.close().catch(() => {}); await b?.close().catch(() => {}); };
  // Closing the agent's window (or Cancel on the dashboard) ends the attempt at once — a pending question or
  // "press Continue" included — instead of leaving it waiting forever. Nothing is submitted.
  let stopped: string | null = null;
  const stop = (why: string) => { if (stopped) return; stopped = why; o.ask.close(); void closeAll(); };
  const checkStopped = () => { if (stopped) throw new Error(`${stopped} — nothing was submitted`); };
  context.on('close', () => stop('The browser window was closed'));
  if (o.control) o.control.cancel = () => stop('Cancelled');
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const watch = (p: Page) => p.on('close', () => { if (context.pages().length === 0) stop('The browser window was closed'); });
    watch(page);
    context.on('page', watch);
    o.out(`Opening ${target}`);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.bringToFront().catch(() => {});
    const form = await openForm(page, target, o);
    checkStopped();

    const fields = await scanForm(form);
    const answers = new Map<string, Answer>();
    for (const f of fields) {
      const a = ruleAnswer(f, facts) ?? learnedAnswer(f, facts);
      if (a) answers.set(f.id, a);
    }
    // Job boards like DOU and Djinni reply with one message box: that box is the cover letter, labelled or not.
    const boxes = fields.filter((f) => f.kind === 'textarea');
    if (boxes.length === 1 && !answers.has(boxes[0].id) && !boxes[0].label.includes('?')) {
      answers.set(boxes[0].id, { value: facts.files.letterText, source: 'rule', note: 'the form\'s only message box: cover letter' });
    }
    // Djinni picks a CV already in your account: the tailored one is attached through "+ Додати резюме" after the fields are filled.
    const djinni = await form.locator(DJINNI_CV_SELECT).count() > 0;
    if (djinni) {
      for (const f of fields.filter((x) => x.name === 'cv_file_upload_id' || x.kind === 'file')) {
        answers.set(f.id, { value: '', source: 'rule', skip: true, note: 'tailored CV attached through "+ Додати резюме"' });
      }
    }
    const open = fields.filter((f) => !answers.has(f.id) && forModel(f));
    if (open.length) {
      for (const [fid, a] of await modelAnswers(ctx, open, facts, row.text, ctx.cfg.apply.maxFreeTextChars)) answers.set(fid, a);
    }
    for (const f of fields.filter((x) => x.required && !answers.has(x.id) && x.kind !== 'file' && x.kind !== 'checkbox')) {
      const typed = await o.ask.question(f);
      if (typed === null) continue;
      const a = toField(f, typed, 'you');
      if (!a) { o.out(`  "${typed}" doesn't match an option — left for you in the browser`); continue; }
      answers.set(f.id, a);
      saveLearned(ctx.cfg.paths.answers, f.label, typed, row.url, ctx.now());
    }

    checkStopped();
    const result: ApplyResult = { status: 'filled', filled: [], missing: [], errors: [], dir: row.pack_dir };
    for (const f of fields) {
      const a = answers.get(f.id);
      if (!a || a.skip) { if (f.required) result.missing.push(f.label || f.name || f.id); continue; }
      const err = await fillField(form, f, a);
      if (err) { result.errors.push(`${f.label}: ${err}`); if (f.required) result.missing.push(f.label); continue; }
      result.filled.push({ label: f.label, value: f.kind === 'file' ? path.basename(String(a.value)) : show(a.value), source: a.source });
    }
    if (djinni && o.mode === 'assisted') {
      const problem = await attachDjinniCv(form, facts.files.cv).catch((e: Error) => `${e.message.split('\n')[0].slice(0, 160)} — attach ${facts.files.cv} yourself`);
      if (problem) { result.missing.push(`Резюме: ${problem}`); await highlight(form, fields.filter((f) => f.name === 'cv_file_upload_id')); }
      else result.filled.push({ label: 'Резюме', value: `${path.basename(facts.files.cv)} (tailored, goes with this reply)`, source: 'rule' });
    } else if (djinni) {
      o.out(`  · Резюме: an assisted run attaches the tailored CV through "+ Додати резюме" (it goes with the reply; your profile CV stays)`);
    }
    await highlight(form, fields.filter((f) => result.missing.includes(f.label || f.name || f.id)));
    await form.screenshot({ path: path.join(row.pack_dir, 'application-form.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(row.pack_dir, 'application.json'), JSON.stringify({
      url: target, mode: o.mode, at: ctx.now().toISOString(),
      fields: fields.map((f) => ({ label: f.label, kind: f.kind, required: f.required, options: f.options.length ? f.options : undefined, answer: answers.get(f.id) })),
      missing: result.missing, errors: result.errors,
    }, null, 2));

    for (const x of result.filled) o.out(`  ✓ ${x.label} = ${x.value}  (${x.source})`);
    for (const m of result.missing) o.out(`  ✗ ${m} — yours to fill in`);
    for (const e of result.errors) o.out(`  ! ${e}`);

    checkStopped();
    if (o.mode === 'simulate') { result.status = 'simulated'; return result; }

    o.out(`\nReview the form in the browser and press Submit yourself. Watching for the confirmation page for ${ctx.cfg.apply.waitMinutes} min (Ctrl+C to stop).`);
    if (await waitForConfirmation(form, ctx.cfg.apply.waitMinutes * 60_000)) {
      await form.screenshot({ path: path.join(row.pack_dir, 'application-confirmation.png'), fullPage: true }).catch(() => {});
      ctx.store.transition(row.id, 'applied', `submitted by you (assisted) on ${ctx.now().toISOString().slice(0, 10)}`);
      fs.appendFileSync(ctx.cfg.paths.appliedSeed, `${row.url}\n`);
      result.status = 'applied';
      o.out(`Confirmation seen — ${row.id} marked applied and added to ${ctx.cfg.paths.appliedSeed}.`);
    } else {
      o.out(`No confirmation seen. If you did submit, run: npm run mark -- ${row.id} applied`);
    }
    return result;
  } finally {
    await closeAll();
  }
}

/**
 * "Apply by email": opens a draft in your mail app with the cover letter as the body — nothing is sent. Mail links
 * can't carry attachments, so the pack folder opens too for you to drag the CV and letter in.
 */
function emailApplication(ctx: Ctx, row: NonNullable<ReturnType<Ctx['store']['get']>>, facts: Facts, address: string, o: ApplyOptions): ApplyResult {
  const open = o.openExternal ?? openInYourBrowser;
  const subject = `Application: ${row.title}`;
  const body = facts.files.letterText.length > 1800 ? '' : facts.files.letterText; // long mailto: links get cut off by some mail apps
  if (o.mode === 'assisted') {
    open(`mailto:${address}?subject=${encodeURIComponent(subject)}${body ? `&body=${encodeURIComponent(body)}` : ''}`);
    open(path.resolve(row.pack_dir!));
  }
  fs.writeFileSync(path.join(row.pack_dir!, 'application.json'), JSON.stringify({ email: address, subject, mode: o.mode, at: ctx.now().toISOString() }, null, 2));
  o.out(`This job takes applications by email: ${address}`);
  o.out(`  subject: ${subject}`);
  o.out(`  attach:  ${facts.files.cv}`);
  o.out(`           ${facts.files.letterDocx}${body ? '' : `\n  body:    paste ${path.join(row.pack_dir!, 'cover_letter.txt')}`}`);
  o.out(o.mode === 'assisted' ? 'A draft is open in your mail app — nothing was sent. Send it yourself, then mark the vacancy applied.' : 'Nothing was opened (preview).');
  return { status: 'email', filled: [], missing: [], errors: [], dir: row.pack_dir! };
}

/**
 * True once the page shows it was submitted: a new confirmation-looking URL, or thank-you text that wasn't there while
 * you were filling in (job pages often say "thank you for your interest" above the form), or that text with most of the
 * form's controls gone.
 */
export async function waitForConfirmation(start: Page, ms: number): Promise<boolean> {
  let page = start;
  // A site can swap the tab for a new one while navigating (a language switch did); follow a tab that appears
  // after the form was filled. If the form tab just closes, stop at once so the dashboard isn't left waiting.
  const fresh: Page[] = [];
  const onPage = (p: Page) => fresh.push(p);
  page.context().on('page', onPage);
  const bodyText = () => page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  const controls = () => page.locator('input:not([type="hidden"]), textarea, select').count().catch(() => -1);
  const startUrl = page.url();
  const startControls = await controls();
  const thankedAlready = CONFIRM_TEXT.test(await bodyText());
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (page.isClosed()) {
      const next = fresh.filter((p) => !p.isClosed()).pop();
      if (!next) { page.context().off('page', onPage); return false; }
      page = next;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
    const url = page.url();
    if (url !== startUrl && CONFIRM_URL.test(url)) return true;
    if (CONFIRM_TEXT.test(await bodyText())) {
      if (!thankedAlready) return true;
      const n = await controls();
      if (n >= 0 && startControls > 0 && n < startControls / 2) return true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
