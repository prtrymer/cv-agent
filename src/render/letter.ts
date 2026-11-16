import fs from 'node:fs';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import type { Plan } from '../pipeline/validate.js';

export interface LetterBase { subject: string; greeting: string; closing: string; signature: string; uk: Record<string, string>; voice: string }

/** The base letter file is both the template (fixed lines) and the voice sample for the prompt. */
export function parseBaseLetter(md: string): LetterBase {
  const fixed = [...md.matchAll(/^(.*?)\s+\[fixed[^\]]*\]\s*$/gm)].map((m) => m[1].trim());
  const uk = Object.fromEntries([...md.matchAll(/^\s*(greeting|closing|signature):\s*(.+)$/gm)].map((m) => [m[1], m[2].trim()]));
  const voice = md.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+\[fixed[^\]]*\]/g, '').trim();
  if (fixed.length < 4) throw new Error('cover letter base: expected 4 [fixed] lines (subject, greeting, closing, signature)');
  return { subject: fixed[0], greeting: fixed[1], closing: fixed[2], signature: fixed[3], uk, voice };
}

export function composeLetter(cl: Plan['cover_letter'], lang: 'en' | 'uk', base: LetterBase, vacancyTitle: string): { subject: string; paragraphs: string[] } {
  const fixed = lang === 'uk'
    ? { greeting: base.uk.greeting ?? base.greeting, closing: base.uk.closing ?? base.closing, signature: base.uk.signature ?? base.signature }
    : { greeting: base.greeting, closing: base.closing, signature: base.signature };
  const body = [cl.intro, cl.snapshot, cl.before, cl.proof].filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim());
  return {
    subject: base.subject.replace('{{vacancy_title}}', vacancyTitle),
    paragraphs: [fixed.greeting, ...body, fixed.closing, fixed.signature],
  };
}

/** Times New Roman 12pt, plain paragraphs, blank-line spacing — the shape of his existing letters. */
export async function writeLetterDocx(file: string, subject: string, paragraphs: string[]): Promise<void> {
  const children: Paragraph[] = [];
  const add = (t: string) => children.push(new Paragraph({ children: [new TextRun(t)] }));
  const blank = () => children.push(new Paragraph({ children: [] }));
  add(subject);
  blank();
  paragraphs.forEach((p, i) => { add(p); if (i < paragraphs.length - 1) blank(); });
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, children }],
  });
  fs.writeFileSync(file, await Packer.toBuffer(doc));
}

export const letterText = (paragraphs: string[]): string => `${paragraphs.join('\n\n')}\n`;
