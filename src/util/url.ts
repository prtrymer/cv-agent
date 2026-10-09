export interface Canonical { key: string; url: string }

/** Stable identity for a job URL, so the same vacancy seen via different links (tracking params, ?sent, /confirmation) dedupes. */
export function canonicalize(raw: string): Canonical | null {
  let u: URL;
  try { u = new URL(raw.trim().replace(/\\([#_])/g, '$1')); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const p = u.pathname;
  let m: RegExpExecArray | null;
  let n: RegExpExecArray | null;
  if (host === 'jobs.dou.ua' && (m = /^\/companies\/([^/]+)\/vacancies\/(\d+)/.exec(p))) return { key: `dou:${m[2]}`, url: `https://jobs.dou.ua/companies/${m[1]}/vacancies/${m[2]}/` };
  if (host === 'djinni.co' && (m = /^\/jobs\/(\d+)(-[^/]*)?/.exec(p))) return { key: `djinni:${m[1]}`, url: `https://djinni.co/jobs/${m[1]}${m[2] ?? ''}/` };
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    const id = /\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/.exec(p)?.[1] ?? u.searchParams.get('currentJobId');
    if (id) return { key: `linkedin:${id}`, url: `https://www.linkedin.com/jobs/view/${id}/` };
  }
  if (/(^|\.)glassdoor\./.test(host)) {
    const id = u.searchParams.get('jl') ?? u.searchParams.get('jobListingId');
    if (id) return { key: `glassdoor:${id}`, url: `https://www.glassdoor.com/job-listing/j?jl=${id}` };
  }
  if (/(^|\.)indeed\.com$/.test(host)) {
    const jk = u.searchParams.get('jk') ?? u.searchParams.get('vjk');
    if (jk && /^[0-9a-f]{8,}$/i.test(jk)) return { key: `indeed:${jk.toLowerCase()}`, url: `https://${host === 'indeed.com' ? 'www.indeed.com' : host}/viewjob?jk=${jk.toLowerCase()}` };
  }
  if (/(^|\.)jobs\.cz$/.test(host)) {
    const id = /^\/rpd\/(\d+)/.exec(p)?.[1] ?? (/detail-pozice/.test(p) ? u.searchParams.get('id') : null);
    if (id && /^\d+$/.test(id)) return { key: `jobscz:${id}`, url: `https://www.jobs.cz/rpd/${id}/` };
  }
  if (/(^|\.)greenhouse\.io$/.test(host) && (m = /^\/([^/]+)\/jobs\/(\d+)/.exec(p))) return { key: `greenhouse:${m[1]}:${m[2]}`, url: `https://job-boards.greenhouse.io/${m[1]}/jobs/${m[2]}` };
  if (host === 'jobs.ashbyhq.com' && (m = /^\/([^/]+)\/([0-9a-f-]{36})/i.exec(p))) return { key: `ashby:${m[2].toLowerCase()}`, url: `https://jobs.ashbyhq.com/${m[1]}/${m[2]}` };
  if ((host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') && (m = /^\/([^/]+)\/([0-9a-f-]{36})/i.exec(p))) return { key: `lever:${m[2].toLowerCase()}`, url: `https://${host}/${m[1]}/${m[2]}` };
  if (host === 'apply.workable.com' && (m = /^\/([^/]+)\/j\/([a-z0-9]+)/i.exec(p))) return { key: `workable:${m[2].toUpperCase()}`, url: `https://apply.workable.com/${m[1]}/j/${m[2]}/` };
  if (host === 'apply.workable.com' && (m = /^\/j\/([a-z0-9]+)/i.exec(p))) return { key: `workable:${m[1].toUpperCase()}`, url: `https://apply.workable.com/j/${m[1]}/` };
  if ((m = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host)) && (n = /^\/o\/([^/]+)/.exec(p))) return { key: `recruitee:${m[1]}:${n[1].toLowerCase()}`, url: `https://${m[1]}.recruitee.com/o/${n[1]}` };
  if (host === 'jobs.smartrecruiters.com' && (m = /^\/([^/]+)\/(\d{6,})/.exec(p))) return { key: `smartrecruiters:${m[2]}`, url: `https://jobs.smartrecruiters.com/${m[1]}/${m[2]}` };
  const clean = `${host}${p.replace(/\/+$/, '')}`.toLowerCase();
  return { key: `url:${clean}`, url: `https://${host}${p}` };
}
