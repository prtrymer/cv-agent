import type { Page } from 'playwright';
import type { Answer } from './answers.js';
import { locate, locateOption, type Field } from './scan.js';

/** Puts one answer into its field. Returns why it failed, or null. Never clicks anything that submits. */
export async function fillField(page: Page, f: Field, a: Answer): Promise<string | null> {
  const loc = locate(page, f);
  const v = a.value;
  try {
    switch (f.kind) {
      case 'file': await loc.setInputFiles(String(v)); break;
      case 'checkbox': await loc.setChecked(v === true, { force: true }); break;
      case 'select': await loc.selectOption({ label: String(v) }); break;
      case 'radio': {
        const i = f.options.indexOf(String(v));
        if (i < 0) return `"${v}" is not an option`;
        await locateOption(page, f, i).check({ force: true });
        break;
      }
      case 'checkboxes': {
        for (const o of Array.isArray(v) ? v : [String(v)]) {
          const i = f.options.indexOf(o);
          if (i >= 0) await locateOption(page, f, i).check({ force: true });
        }
        break;
      }
      case 'combobox': {
        const text = Array.isArray(v) ? v[0] : String(v);
        // Search-as-you-type pickers (locations) match on the first part: "Olomouc, Czech Republic" → "Olomouc".
        const typed = f.options.length ? text : text.split(',')[0].trim();
        await loc.click();
        await loc.fill(typed);
        await page.waitForTimeout(f.options.length ? 400 : 1200);
        const option = page.frames()[f.frame].locator('[role="option"]:visible').filter({ hasText: typed }).first();
        if (await option.count()) await option.click();
        else await loc.press('Enter');
        break;
      }
      default: await loc.fill(String(v));
    }
    return null;
  } catch (e) {
    return (e as Error).message.split('\n')[0].slice(0, 160);
  }
}

/** Outlines the fields still waiting for you, so they stand out when you review the form. */
export async function highlight(page: Page, fields: Field[]): Promise<void> {
  for (const f of fields) {
    // A function, not a string: Playwright evaluates a string as an expression and never calls it with the element.
    await locate(page, f).evaluate((el: any) => {
      const t = el.type === 'file' || el.type === 'radio' || el.type === 'checkbox' ? (el.closest('label, fieldset, div') || el) : el;
      t.style.outline = '3px solid #e5484d';
      t.style.outlineOffset = '2px';
    }).catch(() => {});
  }
}
