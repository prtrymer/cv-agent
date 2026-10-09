import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import type { Knowledge } from '../profile/profile.js';
import { excludedFor, parseYm, resolveSkill, titleFor, ymIdx } from '../profile/profile.js';
import { detectTech } from '../profile/lexicon.js';
import type { RoleFamily } from '../types.js';
import type { Plan } from '../pipeline/validate.js';

const execFileAsync = promisify(execFile);

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const year = (s: string): string => (s === 'present' ? 'present' : s.slice(0, 4));
const dates = (start: string, end: string): string => `${year(start)} – ${year(end)}`;

/** Compact one-page CV in the master's shape. Tables and floats only — wkhtmltopdf's engine has no flexbox. */
export function renderCvHtml(k: Knowledge, plan: Plan, css: string, family: RoleFamily, wanted: Set<string> = new Set()): string {
  const p = k.profile;
  const fam = k.families.get(family);
  // Technologies this family's CV never shows: taglines, skills and projects drop them like the plan does.
  const excluded = excludedFor(fam, wanted);
  const off = (s: string): boolean => [...detectTech(s)].some((id) => excluded.has(id));
  const tagline = (t: string): string => t.split('/').map((x) => x.trim()).filter((x) => x && !off(x)).join(' / ');
  const c = k.answers.contact as Record<string, string | undefined>;
  const phones = [c.phone && `${c.phone} (CZ)`, c.phone_alt && `${c.phone_alt} (UA)`].filter(Boolean).join(' | ');
  const contacts = [p.person.location, c.email, p.person.links.github].filter(Boolean).join(' | ');

  const chosen = plan.entries
    .map((e) => ({ entry: e, eng: k.engagements.get(e.engagement)! }))
    .filter((x) => x.eng)
    .sort((a, b) => ymIdx(parseYm(b.eng.start, 'start', k.now)) - ymIdx(parseYm(a.eng.start, 'start', k.now)));

  const row = (left: string, right: string): string =>
    `<table class="row"><tr><td class="l">${left}</td><td class="r">${right}</td></tr></table>`;

  const jobHtml = (x: { entry: Plan['entries'][number]; eng: Knowledge['profile']['engagements'][number] }, nested: boolean): string => {
    const head = row(
      `<b>${esc(x.eng.company)}</b> — ${esc(titleFor(x.eng, fam))}${tagline(x.eng.tagline) ? ` <span class="tag">· ${esc(tagline(x.eng.tagline))}</span>` : ''}`,
      esc(dates(x.eng.start, x.eng.end)),
    );
    const bullets = x.entry.bullets
      .map((b) => `<li>${esc(b.text ?? k.bullets.get(b.id)?.text ?? '')}</li>`)
      .join('');
    return `<div class="job${nested ? ' nested' : ''}">${head}<ul>${bullets}</ul></div>`;
  };

  const groups = p.groups.filter((g) => chosen.some((x) => x.eng.group === g.id));
  const parts: string[] = [];
  for (const g of groups) {
    parts.push(`<div class="job">${row(`<b>${esc(g.name)}</b> — ${esc(g.title)}`, esc(dates(g.start, g.end)))}</div>`);
    for (const x of chosen.filter((x) => x.eng.group === g.id)) parts.push(jobHtml(x, true));
  }
  for (const x of chosen.filter((x) => !x.eng.group || !groups.some((g) => g.id === x.eng.group))) parts.push(jobHtml(x, false));

  const first = new Map<string, number>();
  const allItems = p.skills.flatMap((g) => g.items);
  plan.skills_first.slice(0, 12).forEach((s, i) => { const item = resolveSkill(s, allItems); if (item && !first.has(item.toLowerCase())) first.set(item.toLowerCase(), i); });
  const skills = p.skills
    .filter((g) => !off(g.group))
    .map((g) => ({ group: g.group, items: g.items.filter((i) => !off(i)) }))
    .filter((g) => g.items.length > 0)
    .map((g) => ({ group: g.group, items: [...g.items].sort((a, b) => (first.get(a.toLowerCase()) ?? 99) - (first.get(b.toLowerCase()) ?? 99)) }))
    .sort((a, b) => Math.min(...a.items.map((i) => first.get(i.toLowerCase()) ?? 99)) - Math.min(...b.items.map((i) => first.get(i.toLowerCase()) ?? 99)))
    .map((g) => `<p><b>${esc(g.group)}</b> — ${esc(g.items.join(', '))}</p>`)
    .join('');

  const projects = p.education.projects
    .filter((pr) => !off(pr.title))
    .map((pr) => `<p><b>${esc(pr.title)}</b> — ${esc(pr.stack.join(', '))}</p>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(p.person.name)} — CV</title><style>${css}</style></head>
<body><div class="page">
<header>
  <h1>${esc(p.person.name.toUpperCase())}</h1>
  <div class="headline">${esc(plan.headline)}</div>
  <div class="contacts">${esc(contacts)}</div>
  ${phones ? `<div class="contacts">${esc(phones)}</div>` : ''}
</header>
<p class="summary">${esc(plan.summary)}</p>
<h2>Experience</h2>
${parts.join('\n')}
${plan.include_ai_section ? `<h2>AI-Agent Development Workflow</h2><p>${esc(p.ai_agent_section.master.trim())}</p>` : ''}
<h2>Education</h2>
${row(`<b>${esc(p.education.degree)}</b> — ${esc(p.education.school)}`, esc(dates(p.education.start, p.education.end)))}
${projects}
<h2>Skills</h2>
<div class="skills">${skills}<p><b>Languages</b> — ${esc(p.languages.map((l) => `${l.name} (${l.level})`).join(', '))}</p></div>
</div></body></html>`;
}

const CHROMIUM = [
  'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const exists = (bin: string): boolean => (bin.includes('/')
  ? fs.existsSync(bin)
  : (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, bin))));

/** The renderer to run: `render.binary` if set, else the first known install found (PATH, then the macOS app bundles). */
export function rendererBinary(render: Config['render']): { bin: string | null; tried: string[] } {
  if (render.engine === 'none') return { bin: null, tried: [] };
  if (render.engine === 'playwright') {
    const bin = playwrightChromium();
    return { bin: bin && fs.existsSync(bin) ? bin : null, tried: [bin ?? 'Playwright Chromium (run `npx playwright install chromium`)'] };
  }
  const tried = render.binary ? [render.binary] : render.engine === 'wkhtmltopdf' ? ['wkhtmltopdf'] : CHROMIUM;
  return { bin: tried.find(exists) ?? null, tried };
}

export async function htmlToPdf(htmlFile: string, pdfFile: string, render: Config['render']): Promise<{ pages: number | null; error?: string }> {
  if (render.engine === 'none') return { pages: null };
  const { bin, tried } = rendererBinary(render);
  if (render.engine === 'playwright' && bin) return playwrightPdf(htmlFile, pdfFile);
  if (!bin) return { pages: null, error: `${render.engine} not found (looked for ${tried.join(', ')}) — install it, set render.binary, or set render.engine: none` };
  const args = render.engine === 'wkhtmltopdf'
    ? ['--quiet', '--page-size', 'A4', '--disable-smart-shrinking', '--encoding', 'utf-8', '--enable-local-file-access', '-T', '0', '-B', '0', '-L', '0', '-R', '0', htmlFile, pdfFile]
    : ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdfFile}`, pathToFileURL(htmlFile).href];
  try {
    await execFileAsync(bin, args, { timeout: 60_000 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { pages: null, error: `${bin} not found — install it, set render.binary, or set render.engine: none` };
    if (!fs.existsSync(pdfFile)) return { pages: null, error: String(err.message).slice(0, 200) };
  }
  return { pages: await pdfPages(pdfFile) };
}

let chromiumPath: string | null | undefined;
function playwrightChromium(): string | null {
  if (chromiumPath !== undefined) return chromiumPath;
  try {
    const require = createRequire(import.meta.url);
    chromiumPath = (require('playwright') as typeof import('playwright')).chromium.executablePath();
  } catch {
    chromiumPath = null;
  }
  return chromiumPath;
}

/** Headless Chromium through Playwright: the same engine the apply step drives, so one install covers both. */
async function playwrightPdf(htmlFile: string, pdfFile: string): Promise<{ pages: number | null; error?: string }> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });
    await page.pdf({ path: pdfFile, format: 'A4', printBackground: true, preferCSSPageSize: true });
  } catch (e) {
    return { pages: null, error: String((e as Error).message).slice(0, 200) };
  } finally {
    await browser.close();
  }
  return { pages: await pdfPages(pdfFile) };
}

async function pdfPages(file: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('pdfinfo', [file], { timeout: 15_000 });
    const m = /Pages:\s+(\d+)/.exec(stdout);
    if (m) return Number(m[1]);
  } catch { /* poppler not installed — fall back to counting page objects */ }
  const raw = fs.readFileSync(file, 'latin1');
  return (raw.match(/\/Type\s*\/Page(?![s/])/g) ?? []).length || null;
}
