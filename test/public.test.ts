import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { manualVacancy } from '../src/sources/manual.js';
import { findOnLinkedin, innerOf, parseJobsCz, parseLinkedinPosting, parseLinkedinSearch, parseRobota, readLinkedinJob, readRobota } from '../src/sources/public.js';
import { canonicalize } from '../src/util/url.js';

const page = (name: string) => fs.readFileSync(`fixtures/pages/${name}`, 'utf8');
const http = { userAgent: 'test', timeoutMs: 5000, minIntervalMsPerHost: 0, maxBytes: 3_000_000, retries: 0 };
afterEach(() => vi.unstubAllGlobals());

function stubFetch(routes: Array<[string, string | number]>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const hit = routes.find(([k]) => url.includes(k));
    if (!hit) return new Response('not found', { status: 404 });
    if (typeof hit[1] === 'string') return new Response(hit[1], { status: 200 });
    // Response() refuses LinkedIn's 999, so a bare stand-in carries it.
    return { status: hit[1], ok: false, headers: new Headers(), body: null } as unknown as Response;
  });
  return calls;
}

describe('public job pages', () => {
  it('takes a whole element, nested ones included', () => {
    expect(innerOf('<div class="a"><div>x</div><p>y</p></div><div>z</div>', /<div class="a">/)).toBe('<div>x</div><p>y</p>');
    expect(innerOf('<div class="a">unclosed', /<div class="a">/)).toBeNull();
  });
  it("reads LinkedIn's logged-out job view", () => {
    const p = parseLinkedinPosting(page('linkedin-posting.html'))!;
    expect(p).toMatchObject({ title: 'Frontend Engineer (React)', company: 'Nowhere Labs & Co', location: 'Brno, South Moravia, Czechia', closed: false });
    expect(p.descriptionHtml).toContain('<li>Fully remote within Czechia</li></ul></div>'); // the nested list stays in
    expect(p.descriptionHtml).toContain('<li>Seniority level: Mid-Senior level</li><li>Employment type: Full-time</li>');
    expect(p.descriptionHtml).not.toContain('Show more');
    expect(parseLinkedinPosting(page('linkedin-posting.html').replace('</section>', '<figure class="closed-job">No longer accepting applications</figure></section>'))?.closed).toBe(true);
    expect(parseLinkedinPosting('<html>Sign in to view</html>')).toBeNull();
  });
  it("reads LinkedIn's public search cards", () => {
    expect(parseLinkedinSearch(page('linkedin-search.html'))).toEqual([
      { id: '4200000001', title: 'Senior Software Engineer (Full Stack)', company: 'Acme', location: 'Brno, South Moravia, Czechia' },
      { id: '4200000002', title: 'Senior Software Engineer (Swift)', company: 'Acme', location: 'Brno, South Moravia, Czechia' },
      { id: '4200000003', title: 'Senior Full Stack Developer', company: 'UNIQA CZ', location: 'Brno, South Moravia, Czechia' },
    ]);
  });
  it('reads a Jobs.cz posting: header and body, not the benefits box', () => {
    const p = parseJobsCz(page('jobscz-posting.html'))!;
    expect(p).toMatchObject({ title: 'Java vývojář/ka', company: 'Kostka Bank a.s.', location: 'Evropská 2690/17, Praha – Dejvice' });
    expect(p.descriptionHtml).toContain('Kostka Bank is a Czech bank');
    expect(p.descriptionHtml).toContain('Hybrid, two days a week in Prague');
    expect(p.descriptionHtml).not.toContain('Benefits that are not part');
  });

  it('reads a robota.ua vacancy from its API: body only, salary and tags appended, not the benefits', () => {
    const p = parseRobota(page('robota-vacancy.json'))!;
    expect(p).toMatchObject({ title: 'Java developer (middle+)', company: 'Nowhere Processing LLC', location: 'Киев, Remote', closed: false });
    expect(p.descriptionHtml).toMatch(/^<p><strong>Основні задачі:/);
    expect(p.descriptionHtml).toContain('<li>Salary: 80000–110000 UAH</li><li>Вид занятости: Полная занятость, Удаленная работа</li><li>Язык программирования: Java, SQL</li></ul>');
    expect(p.descriptionHtml).not.toContain('Опыт работы'); // a tag with nothing in it
    expect(p.descriptionHtml).not.toContain('Курсы');
    expect(parseRobota(page('robota-vacancy.json').replace('"isActive": true', '"isActive": false'))?.closed).toBe(true);
    expect(parseRobota('<!DOCTYPE html><title>Just a moment...</title>')).toBeNull();
  });
  it('knows robota.ua and rabota.ua links by vacancy id, tracking stripped', () => {
    expect(canonicalize('https://robota.ua/company589525/vacancy11381253?utm_source=jobalert&utm_term=1')).toEqual({ key: 'robota:11381253', url: 'https://robota.ua/company589525/vacancy11381253' });
    expect(canonicalize('https://rabota.ua/ua/company589525/vacancy11381253')?.key).toBe('robota:11381253');
    expect(canonicalize('https://robota.ua/ru/vacancy11381253')).toEqual({ key: 'robota:11381253', url: 'https://robota.ua/vacancy11381253' });
  });
  it('robota.ua: API by id, removed vacancies closed, Cloudflare treated as pushback', async () => {
    const calls = stubFetch([['vacancy?id=11000001', page('robota-vacancy.json')], ['vacancy?id=2', 403]]);
    expect(await readRobota('https://robota.ua/company500001/vacancy11000001?utm_source=jobalert', http))
      .toMatchObject({ kind: 'found', via: 'robota', posting: { url: 'https://robota.ua/company500001/vacancy11000001', title: 'Java developer (middle+)' } });
    expect(calls[0]).toBe('https://api.rabota.ua/vacancy?id=11000001');
    expect(await readRobota('https://robota.ua/vacancy3', http)).toEqual({ kind: 'closed', reason: 'removed from robota.ua' });
    expect(await readRobota('https://robota.ua/vacancy2', http)).toMatchObject({ kind: 'throttled', host: 'api.rabota.ua' });
  });

  it('finds a Glassdoor job on LinkedIn by company and title, not a namesake at another company', async () => {
    const calls = stubFetch([['seeMoreJobPostings/search', page('linkedin-search.html')], ['jobPosting/4200000001', page('linkedin-posting.html')]]);
    const r = await findOnLinkedin({ title: 'Senior Software Engineer (Full Stack)', company: 'Acme Software', location: 'Brno' }, http);
    expect(r).toMatchObject({ kind: 'found', via: 'linkedin', posting: { url: 'https://www.linkedin.com/jobs/view/4200000001/' } });
    expect(calls[0]).toContain('keywords=Senior+Software+Engineer+%28Full+Stack%29+Acme+Software&location=Brno');
    expect(await findOnLinkedin({ title: 'Senior Full Stack Developer', company: 'Acme Software', location: 'Remote' }, http)).toEqual({ kind: 'missing', reason: 'not found on LinkedIn' });
    expect(calls.at(-1)).not.toContain('location='); // "Remote" is no place to search in
  });
  it('tells pushback (stop for this run) from a removed job', async () => {
    stubFetch([['jobPosting/1', 999], ['jobPosting/2', 404], ['jobPosting/3', 429]]);
    expect(await readLinkedinJob('1', http)).toEqual({ kind: 'throttled', host: 'www.linkedin.com', reason: 'www.linkedin.com answered 999' });
    expect(await readLinkedinJob('2', http)).toEqual({ kind: 'closed', reason: 'removed from LinkedIn' });
    expect((await readLinkedinJob('3', http)).kind).toBe('throttled');
  });

  it('`add <linkedin link>` reads the public page; Glassdoor still needs the text', async () => {
    stubFetch([['jobPosting/4100000002', page('linkedin-posting.html')]]);
    const cfg = loadConfig('config/demo.yaml');
    cfg.alerts.publicPages.minIntervalMs = 0;
    expect(await manualVacancy('https://cz.linkedin.com/jobs/view/frontend-engineer-at-nowhere-4100000002?trk=x', null, cfg))
      .toMatchObject({ source: 'manual', url: 'https://www.linkedin.com/jobs/view/4100000002/', title: 'Frontend Engineer (React)', company: 'Nowhere Labs & Co' });
    await expect(manualVacancy('https://www.glassdoor.com/job-listing/j?jl=1010000000001', null, cfg)).rejects.toThrow(/pass it with --file/);
    cfg.alerts.publicPages.enabled = false;
    await expect(manualVacancy('https://www.linkedin.com/jobs/view/4100000002/', null, cfg)).rejects.toThrow(/aren't fetched/);
  });
  it('`add <company page>` reads a microdata JobPosting (SuccessFactors jobs2web has no JSON-LD)', async () => {
    stubFetch([['nowherelocks.jobs2web.com', page('jobs2web-posting.html')]]);
    const cfg = loadConfig('config/demo.yaml');
    cfg.http.minIntervalMsPerHost = 0;
    const v = await manualVacancy('https://nowherelocks.jobs2web.com/job/Brno-Software-Engineer-61200/1000000001/', null, cfg);
    expect(v).toMatchObject({ title: 'Software Engineer', company: 'Nowhere Locks & Doors', location: 'Medlánky, CZ, 61200' });
    expect(v.descriptionHtml).toContain('Go, TypeScript, Java, Python');
    expect(v.descriptionHtml).not.toContain('Apply now');
  });
  it('`add <workable link>` reads the job from the API: the page is an empty shell', async () => {
    const job = JSON.stringify({
      title: 'Staff Engineer (remote work)', remote: true, workplace: 'remote', published: '2026-10-09T00:00:00.000Z',
      location: { city: 'Madrid', country: 'Spain' },
      locations: [{ city: 'Madrid', country: 'Spain' }, { city: 'Lisbon', country: 'Portugal' }, { city: 'Prague', country: 'Czechia' }],
      description: '<p>70% hands-on software engineering</p>', requirements: '<ul><li>Python, Go, Java, Rust</li></ul>', benefits: '<p>Remote</p>',
    });
    const calls = stubFetch([['api/v2/accounts/nowherecare/jobs/27FF09D254', job], ['api/v1/widget/accounts/nowherecare', JSON.stringify({ name: 'NowhereCare' })]]);
    const cfg = loadConfig('config/demo.yaml');
    cfg.http.minIntervalMsPerHost = 0;
    const v = await manualVacancy('https://apply.workable.com/nowherecare/j/27FF09D254/', null, cfg);
    expect(v).toMatchObject({ title: 'Staff Engineer (remote work)', company: 'NowhereCare', location: 'Madrid, Spain; Lisbon, Portugal; Prague, Czechia (remote)', postedAt: '2026-10-09T00:00:00.000Z' });
    expect(v.descriptionHtml).toBe('<p>70% hands-on software engineering</p><h2>Requirements</h2><ul><li>Python, Go, Java, Rust</li></ul><h2>Benefits</h2><p>Remote</p>');
    expect(calls.some((c) => c.endsWith('/nowherecare/j/27FF09D254/'))).toBe(false);   // the shell page is never fetched
  });
  it('`add <greenhouse link>` reads the job from the API: custom career sites load it in an iframe', async () => {
    const job = JSON.stringify({ title: 'Full-Stack Software Engineer ', company_name: 'Acme Software', location: { name: 'Remote - Czech Republic' }, content: '&lt;p&gt;Build APIs&lt;/p&gt;', first_published: '2026-03-16T09:42:59-04:00' });
    const calls = stubFetch([['boards-api.greenhouse.io/v1/boards/acmesoftware/jobs/4000000006', job]]);
    const cfg = loadConfig('config/demo.yaml');
    cfg.http.minIntervalMsPerHost = 0;
    expect(await manualVacancy('https://job-boards.greenhouse.io/acmesoftware/jobs/4000000006', null, cfg))
      .toMatchObject({ title: 'Full-Stack Software Engineer', company: 'Acme Software', location: 'Remote - Czech Republic', descriptionHtml: '<p>Build APIs</p>' });
    expect(calls).toHaveLength(1);
    stubFetch([['nowhere.test/openings', '<script src="https://boards.greenhouse.io/embed/job_board/js?for=acmesoftware"></script>'], ['boards-api.greenhouse.io/v1/boards/acmesoftware/jobs/4000000006', job]]);
    expect(await manualVacancy('https://nowhere.test/openings/?gh_jid=4000000006', null, cfg))
      .toMatchObject({ url: 'https://job-boards.greenhouse.io/acmesoftware/jobs/4000000006', title: 'Full-Stack Software Engineer' });
  });
  it('`add <robota.ua link>` reads the vacancy from the API, never the Cloudflare page', async () => {
    const calls = stubFetch([['api.rabota.ua/vacancy?id=11000001', page('robota-vacancy.json')]]);
    const cfg = loadConfig('config/demo.yaml');
    cfg.http.minIntervalMsPerHost = 0;
    expect(await manualVacancy('https://robota.ua/company500001/vacancy11000001?utm_source=jobalert', null, cfg))
      .toMatchObject({ source: 'manual', url: 'https://robota.ua/company500001/vacancy11000001', title: 'Java developer (middle+)', company: 'Nowhere Processing LLC', location: 'Киев, Remote' });
    expect(calls).toEqual(['https://api.rabota.ua/vacancy?id=11000001']);
    await expect(manualVacancy('https://robota.ua/vacancy9', null, cfg)).rejects.toThrow(/closed \(removed from robota.ua\)/);
  });
});
