import { convert } from 'html-to-text';

export const htmlToText = (html: string): string =>
  convert(html, { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] });

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Untrusted posting text → safe prompt payload: no hidden characters, no fake delimiter tags, bounded length. */
export function sanitizeUntrusted(text: string, limit: number): string {
  let t = text.normalize('NFKC').replace(INVISIBLE, '').replace(CONTROL, '');
  t = t.replace(/<\/?\s*(vacancy|task|system|instructions?|assistant|tool)\b[^>]*>/gi, (m) => m.replace(/</g, '‹').replace(/>/g, '›'));
  t = t.split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > limit) {
    const cut = t.lastIndexOf('\n', limit);
    t = `${t.slice(0, cut > limit * 0.6 ? cut : limit).trimEnd()}\n[…truncated]`;
  }
  return t;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };
/** "R&amp;D" → "R&D": some feeds escape their titles twice. */
export const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));

/** Single-line fields (title, company) from untrusted sources. */
export const cleanLine = (s: string | null | undefined, max = 200): string | null => {
  if (!s) return null;
  const t = decodeEntities(s).normalize('NFKC').replace(INVISIBLE, '').replace(CONTROL, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

const INJECTION: RegExp[] = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules)/i,
  /disregard\s+(all\s+|the\s+)?(previous|above|prior|system)/i,
  /\b(if|when)\s+you\s+are\s+an?\s+(ai|llm|language model|bot|assistant)\b/i,
  /\byou\s+are\s+(now\s+)?(an?\s+)?(ai|assistant|language model|chatgpt|claude|gpt)\b/i,
  /\b(system|developer)\s+prompt\b/i,
  /\b(score|rate|rank)\s+(this\s+)?(candidate|applicant|cv|resume)\b.{0,20}\d{2,3}/i,
  /\brespond\s+only\s+with\b/i,
];
export const detectInjection = (text: string): string[] => INJECTION.filter((r) => r.test(text)).map((r) => r.source.slice(0, 48));

export type Lang = 'en' | 'uk' | 'ru' | 'cs' | 'other';
export function detectLang(text: string): Lang {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return 'other';
  const cyr = letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length;
  if (cyr / letters.length > 0.4) {
    const uk = (text.match(/[іїєґІЇЄҐ]/g) ?? []).length;
    const ru = (text.match(/[ыэъёЫЭЪЁ]/g) ?? []).length;
    return uk >= ru ? 'uk' : 'ru';
  }
  return (text.match(/[ěščřžůĚŠČŘŽŮ]/g) ?? []).length > 5 ? 'cs' : 'en';
}

export const slug = (s: string, max = 40): string =>
  s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'x';
