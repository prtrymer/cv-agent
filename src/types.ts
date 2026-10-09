export type Status =
  | 'new' | 'filtered' | 'triage_pending' | 'rejected' | 'borderline'
  | 'tailor_pending' | 'needs_review' | 'ready' | 'applied' | 'dismissed' | 'failed'
  /** Screening says apply, and pipeline.approveBeforeTailor holds it for your go before any CV is written. */
  | 'shortlisted'
  /** Seen in an alert, but the posting lives only on LinkedIn/Glassdoor/Indeed/Jobs.cz: apply there, or paste its text. */
  | 'external';

/** Kinds of role the CV can be positioned for; triage assigns one (or "other") to every posting. */
export const ROLE_FAMILIES = ['fullstack', 'frontend', 'backend', 'java'] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];

/** A vacancy as a source hands it over — untrusted, unsanitized. */
export interface RawVacancy {
  source: string;
  url: string;
  title: string;
  company?: string | null;
  location?: string | null;
  descriptionHtml?: string;
  descriptionText?: string;
  postedAt?: string | null;
}
