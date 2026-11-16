import type { Page } from 'playwright';

/** Djinni's reply form: a message box and a "Резюме" picker listing the CVs stored in your Djinni account. */
export const DJINNI_CV_SELECT = 'select[name="cv_file_upload_id"]';
const ADD_CV = /^\s*\+?\s*(додати резюме|add (a |another )?(cv|resume)|добавить резюме)\s*$/i;
const CV_INPUT = 'input[type="file"][name="cv_file"], .js-cv-input-block input[type="file"]';

/**
 * Puts the pack's tailored CV on a Djinni reply instead of the account's general one. "+ Додати резюме" is an htmx
 * link: it swaps the whole Резюме picker (the <select> included) for an upload field, and the file goes with the
 * reply when you press "Надіслати відгук" — nothing is uploaded before that. "Зберегти це резюме в моєму профілі"
 * is left unticked, so your profile keeps its general CV. Returns null when done, or what you need to do by hand.
 */
export async function attachDjinniCv(page: Page, cv: string): Promise<string | null> {
  const byHand = `click "+ Додати резюме" and pick ${cv}`;
  const input = page.locator(CV_INPUT).first();

  if (!(await input.count())) {
    const add = page.locator('a, button, label, span').filter({ hasText: ADD_CV }).last();
    if (!(await add.count())) return `no "+ Додати резюме" on the form — ${byHand}`;
    // A real link would leave the page and lose the filled form: only a script button (or "#") is clicked.
    const href = await add.getAttribute('href').catch(() => null);
    if (href && !/^(#|javascript:)/i.test(href.trim())) return `"+ Додати резюме" opens another page — ${byHand}`;
    await add.click({ timeout: 5_000 });
    const swapped = await input.waitFor({ state: 'attached', timeout: 15_000 }).then(() => true, () => false);
    if (!swapped) return `"+ Додати резюме" showed no upload field — ${byHand}`;
  }

  await input.setInputFiles(cv, { timeout: 5_000 });
  const taken = await input.evaluate((el: any) => el.files?.[0]?.name ?? '', undefined, { timeout: 5_000 }).catch(() => '');
  return taken ? null : `the upload field didn't take the file — ${byHand}`;
}
