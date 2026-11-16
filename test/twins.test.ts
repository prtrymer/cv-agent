import { beforeEach, describe, expect, it } from 'vitest';
import { foldTwins } from '../src/pipeline/twins.js';
import { CARD_ONLY } from '../src/sources/alerts.js';
import { Store } from '../src/store/db.js';
import type { Status } from '../src/types.js';

let store: Store;
const queued = (id: string, over: Partial<{ title: string; company: string | null; text: string; source: string; location: string }> = {}) => {
  store.insertIfNew({ id, source: 'ats-lever', url: `https://jobs.lever.co/acme/${id}`, title: 'Backend Engineer', company: 'Acme', location: id, text: 'The same text', lang: 'en', posted_at: null, status: 'new', status_reason: null, ...over });
  store.transition(id, 'triage_pending', null);
  return id;
};
const moved = (id: string, ...path: Status[]) => { for (const to of path) store.transition(id, to, null); return id; };
const statusOf = (id: string) => store.get(id)?.status;

beforeEach(() => { store = new Store(':memory:'); });

describe('folding the same job listed for several cities', () => {
  it('keeps the oldest of two queued postings and points the other at it', () => {
    queued('brno'); queued('prague');
    expect(foldTwins(store)).toBe(1);
    expect(statusOf('brno')).toBe('triage_pending');
    expect(store.get('prague')).toMatchObject({ status: 'filtered', same_as: 'brno', status_reason: 'same posting as brno' });
    expect(store.twins().map((t) => t.id)).toEqual(['prague']);
  });

  it('keeps the row with a CV, whichever came first', () => {
    moved(queued('prague'), 'shortlisted');
    moved(queued('brno'), 'tailor_pending', 'ready');
    expect(foldTwins(store)).toBe(1);
    expect(statusOf('brno')).toBe('ready');
    expect(store.get('prague')).toMatchObject({ status: 'filtered', same_as: 'brno' });
  });

  it('skips the screening of a new city when you already turned the job down', () => {
    moved(queued('prague'), 'dismissed');
    queued('brno');
    expect(foldTwins(store)).toBe(1);
    expect(store.get('brno')).toMatchObject({ status: 'filtered', same_as: 'prague' });
  });

  it('never hides a shortlisted posting behind one you dismissed', () => {
    moved(queued('prague'), 'dismissed');
    moved(queued('brno'), 'shortlisted');
    expect(foldTwins(store)).toBe(0);
  });

  it('leaves a posting the free filters dropped out of it: its twin in your city stays', () => {
    moved(queued('hanoi'), 'filtered');
    queued('prague');
    expect(foldTwins(store)).toBe(0);
    expect(statusOf('prague')).toBe('triage_pending');
  });

  it('leaves two postings that already have a verdict or a CV as they are', () => {
    moved(queued('brno'), 'rejected');
    moved(queued('prague'), 'rejected');
    expect(foldTwins(store)).toBe(0);
  });

  it('compares company, title, text and board', () => {
    queued('a');
    queued('b', { title: 'Frontend Engineer' });
    queued('c', { company: 'Other' });
    queued('d', { text: 'Different text' });
    queued('e', { source: 'ats-greenhouse' });
    queued('f', { company: null });
    expect(foldTwins(store)).toBe(0);
  });

  it('never folds on an empty text or an alert card', () => {
    queued('a', { text: '' }); queued('b', { text: '' });
    queued('c', { text: `${CARD_ONLY} card` }); queued('d', { text: `${CARD_ONLY} card` });
    expect(foldTwins(store)).toBe(0);
  });

  it('leaves a posting you sent on by hand', () => {
    queued('brno');
    queued('prague');
    store.transition('prague', 'triage_pending', 'marked by hand: triage');
    expect(foldTwins(store)).toBe(0);
  });

  it('brings earlier twins along when their row folds too', () => {
    queued('a'); queued('b');
    foldTwins(store);
    moved('a', 'shortlisted');
    moved(queued('c'), 'tailor_pending', 'ready');
    expect(foldTwins(store)).toBe(1);
    expect(store.twins().map((t) => [t.id, t.same_as])).toEqual(expect.arrayContaining([['a', 'c'], ['b', 'c']]));
  });

  it('gives a folded posting back its card once you send it on by hand', () => {
    queued('brno'); queued('prague');
    foldTwins(store);
    store.transition('prague', 'triage_pending', 'marked by hand: added again (was filtered)');
    expect(store.twins()).toEqual([]);
  });
});
