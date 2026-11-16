import { XMLParser } from 'fast-xml-parser';
import type { RawVacancy } from '../types.js';

const text = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return String((v as Record<string, unknown>)['#text'] ?? '');
  return String(v);
};

/** DOU and Djinni both publish plain RSS 2.0; anything else fails loudly rather than silently returning nothing. */
export function parseRss(xml: string, source: string, kind: 'dou' | 'djinni' | 'rss'): RawVacancy[] {
  const parser = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true, parseTagValue: false, trimValues: true, isArray: (name) => name === 'item' });
  const doc = parser.parse(xml) as any;
  const channel = doc?.rss?.channel;
  if (!channel) throw new Error('not an RSS 2.0 feed (no rss/channel) — check the source URL in config');
  const items: any[] = channel.item ?? [];
  return items.map((it) => toRaw(it, source, kind)).filter((v): v is RawVacancy => v !== null);
}

function toRaw(it: any, source: string, kind: string): RawVacancy | null {
  const url = (text(it.link) || text(it.guid)).trim();
  const rawTitle = text(it.title).trim();
  if (!url || !rawTitle) return null;

  let title = rawTitle;
  let company: string | null = null;
  let location: string | null = null;
  if (kind === 'dou') {
    // "Senior Node.js Developer в Some Company, Київ, віддалено"
    const m = /^(.*\S)\s+в\s+(.+)$/.exec(rawTitle);
    if (m) {
      title = m[1];
      const parts = m[2].split(/,\s*/);
      company = parts.shift() ?? null;
      location = parts.join(', ') || null;
    }
    if (!company) company = /\/companies\/([^/]+)\//.exec(url)?.[1] ?? null;
  }
  if (/^https:\/\/(www\.)?weworkremotely\.com\//.test(url)) {
    // "Company: Senior Full-Stack Developer", with the hiring region in its own tag ("Anywhere in the World").
    const m = /^([^:]{2,80}):\s+(.+)$/.exec(rawTitle);
    if (m) { company = m[1].trim(); title = m[2].trim(); }
    location = text(it.region).trim() || null;
  }
  return { source, url, title, company, location, descriptionHtml: text(it.description), postedAt: text(it.pubDate) || null };
}
