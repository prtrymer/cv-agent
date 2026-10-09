import fs from 'node:fs';
import YAML from 'yaml';
import { titleSimilarity } from '../ats/resolve.js';
import { detectTech, labelOf } from '../profile/lexicon.js';
import { titleFor, yearsWithTech, type Knowledge } from '../profile/profile.js';
import type { Field } from './scan.js';

export type Value = string | string[] | boolean;
export interface Answer { value: Value; source: 'rule' | 'learned' | 'model' | 'you'; note?: string; /** left blank on purpose */ skip?: true }
export interface Learned { question: string; normalized: string; answer: string; source_url?: string; date?: string }
export interface Facts {
  k: Knowledge;
  vacancy: { url: string; source: string; title: string; company: string | null };
  files: { cv: string; letterDocx: string; letterText: string };
  learned: Learned[];
}

const CHOICE = new Set(['select', 'radio', 'checkboxes', 'combobox']);
export const isChoice = (f: Field): boolean => CHOICE.has(f.kind) && f.options.length > 0;
// Unicode letters stay: an ASCII-only version turned every Ukrainian word into "", so "Ні" matched "Так".
const norm = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}+#]+/gu, ' ').trim();
export const normalizeQuestion = (label: string): string => norm(label).replace(/\b(please|kindly|required|optional)\b/g, ' ').replace(/\s+/g, ' ').trim();

const YES = /^(yes|yep|true|ano|так|да)(?![\p{L}\p{N}])/iu;
const NO = /^(no|nope|false|ne|ні|нет)(?![\p{L}\p{N}])/iu;
const DECLINE = /decline|prefer not|don.?t wish|do not wish|not to (say|disclose|answer|self)|rather not|no answer/i;

/** The option a person would pick to say `value`: yes/no by meaning, numbers by range, text by closeness. */
export function pickOption(options: string[], value: string): string | null {
  if (!options.length) return null;
  const v = value.trim();
  if (YES.test(v)) return options.find((o) => YES.test(o.trim())) ?? null;
  if (NO.test(v)) return options.find((o) => NO.test(o.trim())) ?? null;
  if (DECLINE.test(v)) return options.find((o) => DECLINE.test(o)) ?? null;
  if (!norm(v)) return null;
  const exact = options.find((o) => norm(o) === norm(v));
  if (exact) return exact;
  const n = Number(v);
  if (Number.isFinite(n) && /\d/.test(options.join(' '))) {
    for (const o of options) {
      const range = /(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/.exec(o);
      if (range && n >= Number(range[1]) && n <= Number(range[2])) return o;
      const plus = /(\d+(?:\.\d+)?)\s*\+|more than\s*(\d+)|over\s*(\d+)/i.exec(o);
      if (plus && n >= Number(plus[1] ?? plus[2] ?? plus[3])) return o;
      const less = /(?:less than|under|<)\s*(\d+(?:\.\d+)?)/i.exec(o);
      if (less && n < Number(less[1])) return o;
    }
  }
  const contains = options.filter((o) => norm(o).includes(norm(v)) || norm(v).includes(norm(o)));
  if (contains.length === 1) return contains[0];
  if (contains.length > 1) return contains.reduce((a, b) => (titleSimilarity(b, v) > titleSimilarity(a, v) ? b : a));
  let best: { o: string; s: number } | null = null;
  for (const o of options) { const s = titleSimilarity(o, v); if (s >= 0.5 && (!best || s > best.s)) best = { o, s }; }
  return best?.o ?? null;
}

// "… job post" so forms offering both "Saw a LinkedIn job post" and "LinkedIn recruiter reached out" get the right one.
const REFERRAL: Array<[RegExp, string]> = [[/linkedin/, 'LinkedIn job post'], [/glassdoor/, 'Glassdoor job post'], [/indeed/, 'Indeed job post'], [/jobscz/, 'Jobs.cz job post'], [/dou/, 'DOU job post'], [/djinni/, 'Djinni job post'], [/wwr|weworkremotely/, 'We Work Remotely job post']];
const referral = (source: string): string => REFERRAL.find(([re]) => re.test(source))?.[1] ?? 'Company website';

const OTHER_COUNTRY = /\b(united states|u\.?s\.?a?|america|germany|deutschland|united kingdom|u\.?k\.?|britain|canada|poland|netherlands|austria|france|spain|ireland|israel|india|switzerland|slovakia|ukraine|eu\b|european union|europe)\b/i;

function yearsFor(label: string, k: Knowledge): string {
  const techs = [...detectTech(label)].map(labelOf);
  const years = techs.length ? Math.min(...techs.map((t) => yearsWithTech(k.profile, t, k.now))) : k.totalYears;
  return String(years);
}

const COUNTRY_NAMES: Record<string, string[]> = { 'czech republic': ['czechia', 'cesko', 'ceska republika'], czechia: ['czech republic', 'cesko'] };
/** The country as the form spells it ("Czech Republic" in answers.yaml, "Czechia +420" in a phone picker). */
function countryAnswer(f: Field, country: string | null): Value | null {
  if (!country) return null;
  if (!isChoice(f)) return country;
  const names = [norm(country), ...(COUNTRY_NAMES[norm(country)] ?? [])];
  return f.options.find((o) => names.some((n) => norm(o).startsWith(n))) ?? f.options.find((o) => names.some((n) => norm(o).includes(n))) ?? null;
}

/** A rule's way of saying "leave this field blank" — it never goes to the model or to you. */
const SKIP = Symbol('skip');
type Rule = [RegExp, (f: Field, x: Facts) => Value | null | typeof SKIP];
const c = (x: Facts) => x.k.answers.contact as Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null);

/** Ordered: the first rule whose pattern matches the question decides. `null` = the rule knows it can't answer. */
const RULES: Rule[] = [
  [/talent (pool|community)|future (opportunit|opening|role|position|vacanc)|newsletter|marketing|keep me (informed|updated|posted)|job alerts?|кадров\S* резерв|майбутн\S* ваканс|будущ\S* ваканс|rozesílk|budoucí/, (f) => (f.kind === 'checkbox' && !f.required ? false : null)],
  [/privacy|gdpr|data (processing|protection|storage)|personal data|consent|terms (and|&) conditions|i (agree|acknowledge|confirm|have read)|персональн\S* дан|згод|погоджу|согласи|конфіденційн|souhlas|osobních údajů/, (f) => (f.kind === 'checkbox' ? (f.required ? true : null) : null)],
  [/gender|pronoun|\brace\b|ethnic|hispanic|latin[oa]|veteran|disabilit|sexual orientation|transgender|lgbt/, (f) => (isChoice(f) ? f.options.find((o) => DECLINE.test(o)) ?? null : f.kind === 'text' || f.kind === 'textarea' ? 'Prefer not to say' : null)],
  // Resume parsers overwrite fields already filled; social profiles you don't list stay empty.
  [/autofill|auto-fill|parse (my|your) (resume|cv)|import (from|your) (resume|cv)/, () => SKIP],
  [/twitter|\bx\.com|facebook|instagram|tiktok|dribbble|behance|medium|stack ?overflow|youtube/, (f) => (f.required ? null : SKIP)],
  [/(ім['’`ʼ]?я|имя) (та|і|и) (прізвище|фамилия)|^піб$|^фио$|повне ім|полное имя|celé jméno|jméno a příjmení/, (_, x) => str(c(x).full_name)],
  [/\b(first|given)\s*name|^(ім['’`ʼ]?я|имя|jméno|křestní jméno)$/, (_, x) => str(c(x).first_name)],
  [/\b(last|family)\s*name|surname|прізвище|фамилия|příjmení/, (_, x) => str(c(x).last_name)],
  [/preferred (first )?name/, (_, x) => str(c(x).first_name)],
  [/linked\s?in/, (_, x) => str(c(x).linkedin)],
  [/github/, (_, x) => str(c(x).github)],
  [/portfolio|website|personal (site|page)|other (link|url|profile)|\burl\b/, (_, x) => str(c(x).website) ?? str(c(x).portfolio)],
  [/e-?mail|електронн\S* пошт|^пошта$|электронн\S* почт|^почта$/, (_, x) => str(c(x).email)],
  [/phone|mobile|telephone|\btel\b|телефон|telefon|mobil/, (_, x) => str(c(x).phone)],
  [/resume|\bcv\b|curriculum|резюме|životopis/, (f, x) => (f.kind === 'file' ? x.files.cv : null)],
  [/cover\s*letter|motivation(al)? letter|супровідн|сопроводит|průvodní|motivační/, (f, x) => (f.kind === 'file' ? x.files.letterDocx : f.kind === 'textarea' || f.kind === 'text' ? x.files.letterText : null)],
  [/^(full |legal |your )?name$|full name|legal name|your name/, (_, x) => str(c(x).full_name)],
  [/sponsor|\bvisa\b|віз[аиу]|виз[аыу]|спонсор/, () => 'No'],
  [/(authori[sz]ed|eligible|entitled|legally (able|allowed|permitted)|right|permit(ted)?) to work|work (permit|authori[sz]ation)|дозв\S* на роботу|прав\S* на роботу|разрешени\S* на работу|pracovní povolení/, (f) => (OTHER_COUNTRY.test(f.label) && !/czech/i.test(f.label) ? 'No' : 'Yes')],
  [/relocat|переїзд|релокац|переезд|přestěhov/, () => 'No'],
  [/notice period|available to start|earliest start|when can you (start|join)|start date|availability|коли (ви )?(можете|готові) (почати|приступити|вийти)|когда (вы )?(можете|готовы) (начать|приступить|выйти)|nástup/, (f) => (f.kind === 'date' ? null : 'Immediately')],
  [/how did you (first )?(hear|find|learn|discover|come across)|where did you (first )?(hear|find|see|learn|discover)|(referral|lead|application) source|who referred you|звідки (ви )?(дізнал|знаєте)|як (ви )?(дізнал|знайшли)|откуда (вы )?(узнал|знаете)|как (вы )?(узнал|нашли)|jak jste se (dozvěděl|o nás)/, (_, x) => referral(x.vacancy.source)],
  [/years?.{0,40}experience|experience.{0,40}years?|how (many|long)/, (f, x) => yearsFor(f.label, x.k)],
  [/english/, () => 'C1'],
  [/czech (language|level|proficiency)|speak czech/, () => 'Basic'],
  [/current (company|employer)|present employer/, (_, x) => str((x.k.answers as Record<string, any>).current_role?.employer)],
  [/current (job )?title|current (role|position)/, (_, x) => { const e = x.k.profile.engagements[0]; return e ? titleFor(e, undefined) : null; }],
  [/(country|dial|phone|calling) code|код країни|код страны|телефонний код|předvolba/, (f, x) => { const code = /^\+\d{1,4}/.exec(str(c(x).phone) ?? '')?.[0] ?? null; return isChoice(f) ? f.options.find((o) => code && o.replace(/\s/g, '').includes(code)) ?? countryAnswer(f, str(c(x).country)) : code; }],
  [/\bcountry\b|країна|страна|^země$|stát/, (f, x) => countryAnswer(f, str(c(x).country))],
  [/\bcity\b|current location|where (are you|do you) (based|live|reside)|^location$|address|місто|город|^město|місце проживання|місцезнаходження|локація|местоположение/, (f, x) => {
    const city = str(c(x).city);
    if (isChoice(f)) return f.options.find((o) => city && norm(o).includes(norm(city))) ?? countryAnswer(f, str(c(x).country));
    return `${city ?? ''}, ${str(c(x).country) ?? ''}`.replace(/^, |, $/g, '') || null;
  }],
];

/** An answer from the fixed rules (answers.yaml, profile.yaml, computed years), mapped onto the field's options. */
export function ruleAnswer(f: Field, x: Facts): Answer | null {
  const q = f.label.toLowerCase().replace(/[_-]+/g, ' ');
  for (const [re, fn] of RULES) {
    if (!re.test(q)) continue;
    const v = fn(f, x);
    if (v === null) return null;
    if (v === SKIP) return { value: '', source: 'rule', skip: true, note: 'left blank on purpose' };
    return toField(f, v, 'rule');
  }
  return null;
}

/** An answer you gave to the same question on an earlier form. */
export function learnedAnswer(f: Field, x: Facts): Answer | null {
  const q = normalizeQuestion(f.label);
  if (!q) return null;
  const hit = x.learned.find((l) => l.normalized === q) ?? x.learned.find((l) => titleSimilarity(l.normalized, q) >= 0.85);
  return hit ? toField(f, hit.answer, 'learned', `learned from "${hit.question}"`) : null;
}

/** Shapes a value for the field it goes into; a choice with no matching option is no answer at all. */
export function toField(f: Field, v: Value, source: Answer['source'], note?: string): Answer | null {
  if (typeof v === 'boolean') return f.kind === 'checkbox' ? { value: v, source, note } : isChoice(f) ? toField(f, v ? 'Yes' : 'No', source, note) : null;
  if (f.kind === 'checkbox') return YES.test(String(v)) ? { value: true, source, note } : NO.test(String(v)) ? { value: false, source, note } : null;
  if (Array.isArray(v)) {
    if (f.kind !== 'checkboxes') return v.length ? toField(f, v[0], source, note) : null;
    const picked = v.map((s) => pickOption(f.options, s)).filter((o): o is string => Boolean(o));
    return picked.length ? { value: [...new Set(picked)], source, note } : null;
  }
  if (isChoice(f)) {
    const o = pickOption(f.options, v);
    return o ? { value: f.kind === 'checkboxes' ? [o] : o, source, note } : null;
  }
  return { value: v, source, note };
}

/** Appends an answer you typed to answers.yaml `learned:`, keeping the file's comments and layout. */
export function saveLearned(file: string, label: string, answer: string, sourceUrl: string, now = new Date()): Learned {
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const entry: Learned = { question: label, normalized: normalizeQuestion(label), answer, source_url: sourceUrl, date: now.toISOString().slice(0, 10) };
  const seq = doc.get('learned');
  if (YAML.isSeq(seq)) {
    const i = seq.items.findIndex((it) => YAML.isMap(it) && it.get('normalized') === entry.normalized);
    if (i >= 0) seq.items.splice(i, 1);
    seq.add(doc.createNode(entry));
    (seq as YAML.YAMLSeq).flow = false;
  } else {
    doc.set('learned', doc.createNode([entry]));
  }
  fs.writeFileSync(file, doc.toString());
  return entry;
}

export function loadLearned(file: string): Learned[] {
  const doc = YAML.parse(fs.readFileSync(file, 'utf8')) as { learned?: unknown };
  return Array.isArray(doc?.learned) ? (doc.learned as Learned[]).filter((l) => l && typeof l.normalized === 'string' && typeof l.answer === 'string') : [];
}
