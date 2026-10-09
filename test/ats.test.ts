import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBoard } from '../src/ats/boards.js';
import { findBoard, matchPosting, normCompany, slugCandidates, titleSimilarity } from '../src/ats/resolve.js';
import { Store } from '../src/store/db.js';
import { canonicalize } from '../src/util/url.js';

const http = { userAgent: 'test', timeoutMs: 5000, minIntervalMsPerHost: 0, maxBytes: 1_000_000, retries: 0 };
const keepDev = (t: string) => /developer|engineer/i.test(t);

/** Routes fetch() by URL substring; anything unrouted is a 404, like a board that doesn't exist. */
function stubFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response('{"error":"not found"}', { status: 404 });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('company names and board ids', () => {
  it('normalises legal suffixes, accents and punctuation', () => {
    expect(normCompany('Rohlik Group a.s.')).toBe('rohlik');
    expect(normCompany('Livesport s.r.o.')).toBe('livesport');
    expect(normCompany('Škoda Auto a.s.')).toBe('skoda auto');
    expect(normCompany('Kiwi.com')).toBe('kiwi com');
  });
  it('guesses the ids a company is likely to use', () => {
    expect(slugCandidates('Kiwi.com')).toEqual(['kiwicom', 'kiwi-com', 'kiwicomhq']);
    expect(slugCandidates('JetBrains s.r.o.')).toEqual(['jetbrains', 'jetbrainshq']);
  });
});

describe('matching an alert title to a board posting', () => {
  it('ignores seniority and spelling variants', () => {
    expect(titleSimilarity('Senior Full-Stack Developer (Node.js)', 'Full Stack Developer - Node.js')).toBe(1);
    expect(titleSimilarity('Frontend Engineer', 'Backend Engineer')).toBeLessThan(0.6);
  });
  it('picks the closest posting above the threshold, or none', () => {
    const jobs = [
      { source: 'x', url: 'https://a/1', title: 'Backend Engineer (Java)' },
      { source: 'x', url: 'https://a/2', title: 'Senior Frontend Engineer, React' },
    ];
    expect(matchPosting(jobs, 'Frontend Engineer React')?.job.url).toBe('https://a/2');
    expect(matchPosting(jobs, 'Data Scientist')).toBeNull();
  });
});

describe('canonical keys for ATS links', () => {
  it('collapses every link shape to one key', () => {
    expect(canonicalize('https://jobs.eu.lever.co/acme/0b5a4f5e-1c1d-4c1e-9f1a-111122223333/apply')?.key).toBe('lever:0b5a4f5e-1c1d-4c1e-9f1a-111122223333');
    expect(canonicalize('https://apply.workable.com/j/F4C096B22E')?.key).toBe('workable:F4C096B22E');
    expect(canonicalize('https://apply.workable.com/huggingface/j/f4c096b22e/apply/')?.key).toBe('workable:F4C096B22E');
    expect(canonicalize('https://strv.recruitee.com/o/senior-react-developer/c/new')?.key).toBe('recruitee:strv:senior-react-developer');
    expect(canonicalize('https://jobs.smartrecruiters.com/BoschGroup/744000151338960-java-developer?oga=true')?.key).toBe('smartrecruiters:744000151338960');
  });
});

describe('board fetchers', () => {
  it('reads Greenhouse jobs, decodes the escaped HTML and keeps only matching titles', async () => {
    stubFetch({
      'boards-api.greenhouse.io/v1/boards/acme/jobs': { jobs: [
        { id: 11, title: 'Java Developer', company_name: 'Acme', location: { name: 'Prague' }, content: '&lt;p&gt;Spring &amp;amp; JPA&lt;/p&gt;', first_published: '2026-09-01' },
        { id: 12, title: 'Office Manager', company_name: 'Acme', location: { name: 'Prague' }, content: '' },
      ] },
    });
    const b = await fetchBoard({ ats: 'greenhouse', board: 'acme' }, http, { keep: keepDev });
    expect(b.total).toBe(2);
    expect(b.jobs).toHaveLength(1);
    expect(b.jobs[0]).toMatchObject({ url: 'https://job-boards.greenhouse.io/acme/jobs/11', company: 'Acme', location: 'Prague', descriptionHtml: '<p>Spring &amp; JPA</p>' });
  });
  it('falls back to Lever\'s EU host', async () => {
    const calls = stubFetch({ 'api.eu.lever.co/v0/postings/acme': [
      { text: 'Frontend Engineer', hostedUrl: 'https://jobs.eu.lever.co/acme/0b5a4f5e-1c1d-4c1e-9f1a-111122223333', categories: { location: 'Brno' }, workplaceType: 'hybrid', description: '<p>React</p>', lists: [{ text: 'You have', content: '<li>TS</li>' }] },
    ] });
    const b = await fetchBoard({ ats: 'lever', board: 'acme' }, http, { keep: keepDev });
    expect(calls[0]).toContain('api.lever.co');
    expect(b.jobs[0]).toMatchObject({ location: 'Brno (hybrid)' });
    expect(b.jobs[0].descriptionHtml).toContain('<h3>You have</h3><ul><li>TS</li></ul>');
  });
  it('fetches SmartRecruiters details only for new, matching postings', async () => {
    const calls = stubFetch({
      'postings/111': { jobAd: { sections: { jobDescription: { text: '<p>Node.js</p>' } } } },
      'postings/222': { jobAd: { sections: {} } },
      'companies/Acme/postings?': { totalFound: 3, content: [
        { id: '111', name: 'Node.js Developer', company: { name: 'Acme' }, location: { city: 'Prague', country: 'cz', remote: true } },
        { id: '222', name: 'Java Engineer', company: { name: 'Acme' }, location: { city: 'Brno', country: 'cz' } },
        { id: '333', name: 'Accountant', company: { name: 'Acme' }, location: { city: 'Brno', country: 'cz' } },
      ] },
    });
    const b = await fetchBoard({ ats: 'smartrecruiters', board: 'Acme' }, http, { keep: keepDev, known: (u) => u.endsWith('/222') });
    expect(b.jobs.map((j) => j.title)).toEqual(['Node.js Developer']);
    expect(b.jobs[0].location).toBe('Prague, CZ (remote)');
    expect(calls.some((u) => u.includes('postings/222') || u.includes('postings/333'))).toBe(false);
  });
});

describe('board lookup', () => {
  it('finds the board with open jobs, skips empty accounts and remembers the answer', async () => {
    const calls = stubFetch({
      'apply.workable.com/api/v1/widget/accounts/acme': { name: 'Acme', jobs: [] },
      'acme.recruitee.com/api/offers': { offers: [{ title: 'Dev', company_name: 'Acme s.r.o.' }] },
    });
    const store = new Store(':memory:');
    expect(await findBoard('Acme s.r.o.', store, http, 30)).toEqual({ ats: 'recruitee', board: 'acme' });
    const before = calls.length;
    expect(await findBoard('ACME', store, http, 30)).toEqual({ ats: 'recruitee', board: 'acme' });
    expect(calls.length).toBe(before);
  });
  it('remembers "no board" and looks again once it goes stale', async () => {
    const calls = stubFetch({});
    const store = new Store(':memory:');
    const t0 = new Date('2026-09-01');
    expect(await findBoard('Nobody', store, http, 30, t0)).toBeNull();
    const n = calls.length;
    await findBoard('Nobody', store, http, 30, new Date('2026-09-10'));
    expect(calls.length).toBe(n);
    await findBoard('Nobody', store, http, 30, new Date('2026-10-15'));
    expect(calls.length).toBeGreaterThan(n);
  });
});

describe('same company?', () => {
  it('matches real variants and refuses a bare prefix', async () => {
    const { sameCompany } = await import('../src/ats/resolve.js');
    expect(sameCompany('Cognite - AI for Industry', 'Cognite')).toBe(true);
    expect(sameCompany('Livesport s.r.o.', 'Livesport')).toBe(true);
    expect(sameCompany('ITERA Czech Republic, branch', 'ITERA')).toBe(true);
    expect(sameCompany('JetBrains', 'Jet Brains')).toBe(true);
    expect(sameCompany('Air', 'Air Bank a.s.')).toBe(false);
    expect(slugCandidates('Air Bank a.s.')).toEqual(['airbank', 'air-bank', 'airbankhq']);
  });
});
