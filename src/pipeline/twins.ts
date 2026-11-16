import { normCompany } from '../ats/resolve.js';
import { isCardOnly } from '../sources/alerts.js';
import type { Store, VacancyRow } from '../store/db.js';
import type { Status } from '../types.js';

/**
 * Which row of a job stays a card, best first. A verdict outranks the queue, so a new city of a job
 * you already turned down isn't screened again.
 */
const RANK: Status[] = ['applied', 'ready', 'needs_review', 'tailor_pending', 'shortlisted', 'rejected', 'borderline', 'dismissed', 'triage_pending'];
/** Only rows you haven't acted on fold away: a CV, a verdict or an approval stays where it is. */
const FOLDS: Status[] = ['triage_pending', 'shortlisted'];

/**
 * Boards like Lever list one job once per city, each with its own id and the very same text. Folds those into one row
 * so the job is one card, one screening and one CV. Runs after the free filters: a posting they dropped (Hanoi) must
 * not take its Prague twin with it. Same board only, so a twin's form is filled the same way as its row's.
 */
export function foldTwins(store: Store, inScope: (row: VacancyRow) => boolean = () => true): number {
  const groups = new Map<string, VacancyRow[]>();
  for (const row of store.byStatus(RANK, 100_000)) {
    if (!row.company || !row.text.trim() || isCardOnly(row.text)) continue;
    const key = [row.source, normCompany(row.company), row.title.toLowerCase(), row.text].join('\n');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  let folded = 0;
  for (const rows of groups.values()) {
    const [keep, ...rest] = rows.sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status)); // stable: oldest first within a rank
    for (const row of rest) {
      if (!FOLDS.includes(row.status) || !inScope(row) || store.markedByHand(row.id)) continue;
      store.fold(row.id, keep);
      folded++;
    }
  }
  return folded;
}
