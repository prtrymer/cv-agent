import { execFile } from 'node:child_process';
import type { Page } from 'playwright';
import { fetchBoard } from '../ats/boards.js';
import { findBoard, matchPosting, titleSimilarity } from '../ats/resolve.js';
import type { Ctx } from '../ctx.js';
import type { VacancyRow } from '../store/db.js';
import type { Asker } from './ask.js';

/**
 * Some job boards (We Work Remotely) sit behind Cloudflare and show the company's apply link only to a signed-in
 * account. The agent's Playwright window is an automated browser, so their bot check fails there even when you click
 * it yourself — and getting past it is not the agent's job. So those pages are never opened in the agent's window:
 * the job is looked up on the company's own board, or you open the posting in your own browser and paste where
 * "Apply" leads. The agent then fills that form as usual.
 */

const hostOf = (url: string): string | null => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
};

export function onProtectedBoard(url: string, boards: string[]): boolean {
  const host = hostOf(url);
  return Boolean(host && boards.some((b) => host === b || host.endsWith(`.${b}`)));
}

/** Where "Apply" leads: a form the agent can fill, or an address to email the CV to. */
export type ApplyLink = { kind: 'form'; url: string } | { kind: 'email'; address: string };

export function parseApplyLink(input: string): ApplyLink | null {
  const s = input.trim();
  const mail = /^(?:mailto:)?([^\s@?/]+@[^\s@?/]+\.[a-z]{2,})(?:\?.*)?$/i.exec(s);
  if (mail) return { kind: 'email', address: decodeURIComponent(mail[1]) };
  try {
    const u = new URL(s);
    if (['https:', 'http:', 'file:'].includes(u.protocol)) return { kind: 'form', url: u.href }; // file: = a saved form (tests)
  } catch { /* not a URL */ }
  return null;
}

/** Opens a link in your own default browser (or mail app, for mailto:) — never the agent's window. */
export function openInYourBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [url], () => {});
}

// Interstitials of Cloudflare, DataDome, PerimeterX, Akamai and Incapsula: a page in place of the page.
const WALL_TITLE = /^(just a moment|attention required|checking your browser|verifying you are human|pardon our interruption|access denied|один момент|подождите|почекайте)/i;
const WALL_DOM = '#challenge-form, #challenge-running, #cf-challenge-running, #challenge-stage, iframe[src*="captcha-delivery.com"], #px-captcha, #sec-if-cpt-container, iframe[src*="_Incapsula_Resource"]';
const FORM_FIELDS = 'input[type="file"], input[type="email"], textarea';

/** True while the page is a bot-check wall rather than the site. A form with a CAPTCHA at the bottom is not a wall. */
export async function isBotWall(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => '')).trim();
  const wall = WALL_TITLE.test(title) || (await page.locator(WALL_DOM).count().catch(() => 0)) > 0;
  return wall && !(await page.locator(FORM_FIELDS).count().catch(() => 0));
}

/** Some walls clear on their own after a few seconds; this waits for that and nothing more. */
export async function waitOutBotWall(page: Page, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (await isBotWall(page)) {
    if (Date.now() > until || page.isClosed()) return false;
    await page.waitForTimeout(1000).catch(() => {});
  }
  return true;
}

export const botWallMessage = (url: string, handedOver: boolean): string =>
  `${hostOf(url) ?? url} shows a bot check. The agent's window is an automated browser, so that check fails there even when you click it. `
  + (handedOver ? 'The page is open in your own browser now: apply there with the CV and cover letter from the pack' : 'Apply in your own browser with the CV and cover letter from the pack')
  + ', then press "I applied myself" (or `npm run mark -- <id> applied`) — nothing was submitted';

/** The same job on the company's own ATS board (Greenhouse, Lever…), matched by title as alert emails are. */
async function onCompanyBoard(ctx: Ctx, row: VacancyRow): Promise<string | null> {
  if (!row.company) return null;
  const ref = await findBoard(row.company, ctx.store, ctx.cfg.http, ctx.cfg.ats.probeTtlDays, ctx.now());
  if (!ref) return null;
  const board = await fetchBoard(ref, ctx.cfg.http, { keep: (t) => titleSimilarity(t, row.title) >= 0.5 });
  return matchPosting(board.jobs, row.title)?.job.url ?? null;
}

export interface GateOptions {
  mode: 'assisted' | 'simulate';
  ask: Asker;
  out: (line: string) => void;
  openExternal: (url: string) => void;
}

/**
 * The real application link for a posting on a protected board: remembered from last time, found on the company's
 * own board, or pasted by you after clicking "Apply" in your own browser. Null when you cancel (or in simulate mode,
 * which never asks) — nothing is opened in the agent's window then.
 */
export async function resolveApplyLink(ctx: Ctx, row: VacancyRow, o: GateOptions): Promise<ApplyLink | null> {
  const saved = ctx.store.applyLinkGet(row.id);
  const known = saved && parseApplyLink(saved.link);
  if (known) { o.out(`Apply link (${saved.via}): ${saved.link}`); return known; }

  const host = hostOf(row.url)!;
  o.out(`${host} hides the apply link behind a sign-in and a bot check, so the agent doesn't open it in its own window.`);
  if (row.company) {
    o.out(`Looking for the job on ${row.company}'s own job board…`);
    const found = await onCompanyBoard(ctx, row).catch((e: Error) => { o.out(`  lookup failed: ${e.message.slice(0, 120)}`); return null; });
    if (found) {
      o.out(`  found it: ${found}`);
      ctx.store.applyLinkSet(row.id, found, 'company board');
      return { kind: 'form', url: found };
    }
    o.out(`  not on a supported board (Greenhouse, Lever, Ashby, Workable, Recruitee, SmartRecruiters)`);
  }
  if (o.mode === 'simulate') return null;

  o.openExternal(row.url);
  for (let attempt = 0; attempt < 3; attempt++) {
    const typed = await o.ask.link(`The posting is open in your own browser. Sign in to ${host} there if it asks, click "Apply now" (not "AI Auto-Apply"), and paste the address it takes you to: the application form's link, or the email address it says to write to.`);
    if (typed === null) return null;
    const link = parseApplyLink(typed);
    if (!link) { o.out(`  "${typed.slice(0, 80)}" is not a link or an email address`); continue; }
    if (link.kind === 'form' && onProtectedBoard(link.url, ctx.cfg.apply.protectedBoards)) {
      o.out(`  that's still ${host} — paste the page "Apply now" leads to (usually the company's site)`);
      continue;
    }
    ctx.store.applyLinkSet(row.id, link.kind === 'form' ? link.url : `mailto:${link.address}`, 'you');
    return link;
  }
  return null;
}
