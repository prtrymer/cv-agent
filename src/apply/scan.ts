import type { Frame, Page } from 'playwright';

export type FieldKind = 'text' | 'email' | 'tel' | 'url' | 'number' | 'date' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'checkboxes' | 'file' | 'combobox';
export interface Field {
  id: string;
  kind: FieldKind;
  label: string;
  name: string | null;
  required: boolean;
  /** Choices for select, radio, checkbox groups and comboboxes (read by opening the menu). */
  options: string[];
  accept?: string;
  frame: number;
}

/**
 * Runs inside the page. Finds every fillable control, tags it with data-cvagent-id (radio and checkbox groups:
 * data-cvagent-opt="<id>:<index>" per option) and describes it by the text a person would read as its question.
 * A plain string, not a function: tsx instruments functions with helpers that don't exist inside the page.
 */
const SCAN = String.raw`(() => {
  let n = 0;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').replace(/[\s*✱]+$/, '').trim();
  // Button-ish texts that label a file input or a picker but say nothing about the question itself.
  const GENERIC = /^(attach|upload|browse|choose( a)? file|select( a)? file|add file|drop.*|or drag.*|enter manually|paste|remove|x)$/i;
  const useful = (t) => t && !GENERIC.test(t);
  const shown = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const byId = (id) => (id ? document.getElementById(id) : null);
  const CONTROLS = 'input:not([type="hidden"]), select, textarea, [contenteditable="true"]';
  // Plain text just before a node (a <div>Резюме</div> above the upload), skipping toolbars and other fields.
  const before = (node) => {
    let s = node.previousElementSibling;
    for (let i = 0; s && i < 3; i++, s = s.previousElementSibling) {
      if (s.querySelector('button, ' + CONTROLS) || s.matches('button, ' + CONTROLS)) continue;
      const t = clean(s.innerText);
      if (t && t.length <= 160 && useful(t)) return t;
    }
    return '';
  };
  // The field's own question: the nearest label-ish text, never climbing into a box that holds other fields.
  const near = (el, depth) => {
    let child = el;
    let p = el.parentElement;
    for (let i = 0; p && i < depth; i++, child = p, p = p.parentElement) {
      const l = [...p.querySelectorAll('label, legend, [class*="label"], [class*="question"], [class*="title"]')]
        .find((x) => !x.contains(el) && !x.querySelector('input, select, textarea') && clean(x.innerText).length > 1 && useful(clean(x.innerText)));
      if (l) return clean(l.innerText);
      const t = before(child);
      if (t) return t;
      const others = [...p.querySelectorAll(CONTROLS)].filter((x) => x !== el && !x.contains(el) && !el.contains(x) && !(el.name && x.name === el.name));
      if (others.length) break;
    }
    return '';
  };
  const labelOf = (el) => {
    if (el.labels && el.labels.length) { const t = clean([...el.labels].map((l) => l.innerText).join(' ')); if (useful(t)) return t; }
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = clean(lb.split(/\s+/).map((id) => (byId(id) || {}).innerText || '').join(' ')); if (useful(t)) return t; }
    if (useful(clean(el.getAttribute('aria-label')))) return clean(el.getAttribute('aria-label'));
    return near(el, 4) || clean(el.getAttribute('placeholder') || el.name || el.id || '');
  };
  const groupLabel = (el) => {
    const fs = el.closest('fieldset'); const lg = fs && fs.querySelector('legend');
    if (lg && clean(lg.innerText)) return clean(lg.innerText);
    const g = el.closest('[role="radiogroup"], [role="group"]');
    if (g) { const t = clean(g.getAttribute('aria-label') || ((byId(g.getAttribute('aria-labelledby')) || {}).innerText)); if (t) return t; }
    return near(el.closest('label') || el, 5) || clean(el.name);
  };
  const required = (el) => Boolean(el.required || el.getAttribute('aria-required') === 'true' || /[*✱]\s*$/.test(((el.labels && el.labels[0]) || {}).innerText || ''));
  const tag = (el) => { const id = 'f' + n++; el.setAttribute('data-cvagent-id', id); return id; };
  const out = []; const radios = new Map(); const checks = new Map();
  // Only the application form: the <form> with the most fields when there is one. Headers, footers, search boxes and
  // language switchers are never touched — switching a site's language reloads it and wipes what was filled.
  const count = (root) => root.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea, [contenteditable="true"]').length;
  const forms = [...document.querySelectorAll('form')].filter((f) => shown(f) && count(f) >= 2).sort((a, b) => count(b) - count(a));
  const root = forms[0] || document;
  const LANGS = /^(english|українська|українська мова|русский|čeština|česky|deutsch|polski|slovenčina|español|français|italiano|português|eng|ukr|rus|en|uk|ru|cs|cz|de|pl)$/i;
  const chrome = (el) => Boolean(el.closest('header, footer, nav, [role="navigation"], [role="search"], [class*="footer"], [class*="language"], [class*="locale"], [class*="lang-"]'))
    || /(^|[^\p{L}])(lang|language|locale|мова|язык|jazyk)([^\p{L}]|$)/iu.test([el.name, el.id, el.getAttribute('aria-label')].filter(Boolean).join(' '))
    || (el.tagName === 'SELECT' && el.options.length > 1 && [...el.options].filter((o) => LANGS.test(clean(o.text))).length >= Math.max(2, el.options.length - 1));
  for (const el of root.querySelectorAll('input, select, textarea, [contenteditable="true"], [contenteditable=""]')) {
    if (chrome(el)) continue;
    // Rich-text editors (a cover-letter box with B / I / U buttons) are contenteditable, not <textarea>.
    const editable = el.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    if (editable && el.parentElement && el.parentElement.isContentEditable) continue;
    const type = editable ? 'textarea' : (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'search'].includes(type)) continue;
    if (type === 'radio' || type === 'checkbox') {
      if (!shown(el) && !(el.labels && [...el.labels].some(shown))) continue;
      const bucket = type === 'radio' ? radios : checks;
      const key = el.name || 'anon' + n++;
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key).push(el);
      continue;
    }
    if (type !== 'file' && !shown(el)) continue;
    // Widget internals nobody types into (React-Select's invisible required input and the like).
    if (type !== 'file' && (el.getAttribute('aria-hidden') === 'true' || (el.tabIndex < 0 && getComputedStyle(el).opacity === '0'))) continue;
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') {
      out.push({ id: tag(el), kind: 'combobox', label: labelOf(el), name: el.name || null, required: required(el), options: [] });
      continue;
    }
    if (el.tagName === 'SELECT') {
      const options = [...el.options].map((o) => clean(o.text)).filter((t) => t && !/^(select|choose|please select|-+)/i.test(t));
      out.push({ id: tag(el), kind: 'select', label: labelOf(el), name: el.name || null, required: required(el), options });
      continue;
    }
    const kind = editable || el.tagName === 'TEXTAREA' ? 'textarea' : type === 'file' ? 'file' : ['email', 'tel', 'url', 'number', 'date'].includes(type) ? type : 'text';
    out.push({ id: tag(el), kind, label: labelOf(el), name: el.name || null, required: required(el), options: [], accept: el.getAttribute('accept') || undefined });
  }
  const group = (els, kind) => {
    const id = tag(els[0]);
    els.forEach((e, i) => e.setAttribute('data-cvagent-opt', id + ':' + i));
    out.push({ id, kind, label: groupLabel(els[0]), name: els[0].name || null, required: els.some(required), options: els.map(labelOf) });
  };
  for (const els of radios.values()) group(els, 'radio');
  for (const els of checks.values()) {
    if (els.length > 1) { group(els, 'checkboxes'); continue; }
    out.push({ id: tag(els[0]), kind: 'checkbox', label: labelOf(els[0]), name: els[0].name || null, required: required(els[0]), options: [] });
  }
  return out;
})()`;

/** Every fillable field on the page, in every frame; combobox menus are opened once to read their options. */
export async function scanForm(page: Page): Promise<Field[]> {
  const fields: Field[] = [];
  const frames = page.frames();
  for (const [i, frame] of frames.entries()) {
    let found: Omit<Field, 'frame'>[] = [];
    try { found = await frame.evaluate(SCAN) as Omit<Field, 'frame'>[]; } catch { continue; } // cross-origin or detached frame
    for (const f of found) fields.push({ ...f, id: `${i}.${f.id}`, frame: i });
  }
  for (const f of fields.filter((x) => x.kind === 'combobox')) f.options = await comboboxOptions(frames[f.frame], f);
  return fields;
}

export const locate = (page: Page, f: Field) => page.frames()[f.frame].locator(`[data-cvagent-id="${f.id.split('.')[1]}"]`);
export const locateOption = (page: Page, f: Field, index: number) => page.frames()[f.frame].locator(`[data-cvagent-opt="${f.id.split('.')[1]}:${index}"]`);

async function comboboxOptions(frame: Frame, f: Field): Promise<string[]> {
  const loc = frame.locator(`[data-cvagent-id="${f.id.split('.')[1]}"]`);
  try {
    await loc.click({ timeout: 2000 });
    await frame.waitForTimeout(300);
    // Only this field's list: other pickers (phone country codes…) keep their options in the DOM too.
    const owned = (await loc.getAttribute('aria-controls')) ?? (await loc.getAttribute('aria-owns'));
    const scope = owned ? frame.locator(`[id="${owned}"] [role="option"]`) : frame.locator('[role="option"]:visible');
    const texts = await scope.allInnerTexts();
    await loc.press('Escape');
    return [...new Set(texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 200);
  } catch {
    return [];
  }
}
