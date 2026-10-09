# Prompt changelog
Prompts are versioned files. For a behaviour change, copy to a new version (v1 → v2), point config/agent.yaml at it and note why here.
Every LLM call logs the prompt version and hash, and the hash is part of the cache key, so an edited prompt never serves stale cached answers.

- triage/v1, tailor/v1 — initial versions (2026-09-22).
- triage/v2, tailor/v2 — role families (2026-09-23). Triage defines fullstack/frontend/backend/java/other and compares
  required years per technology against computed commercial years. Tailoring positions the CV for the family named in
  <task> (headline, angle); job titles moved from the model to code (first title the family prefers).
- extract/v1 — job cards out of LinkedIn/Glassdoor alert emails; URLs restricted to the links code found (2026-09-23).
- answer/v1 — application-form questions; choices must be real options, anything unsupported is "unknown" and asked in person (2026-09-23).
- extract/v2 — job links become code-assigned tokens (cheaper, and the model can only pick links code vetted); Indeed, Jobs.cz and Djinni alerts (2026-09-23).
  Amended before first real use (2026-09-23, after a live test): summary ≤ 600 characters; durations only from the
  fact base (the model had copied "a year on an Elixir platform" from the voice sample); skills_first copied exactly.
- tailor/v3 — Ukrainian letters use «Коротко:» / «До цього:» and stay Ukrainian throughout; the voice sample's durations
  are shown as [duration] (the model kept copying "a year on…" into letters for engagements of other lengths) (2026-09-23).
- triage/v3 — asks of up to {{years_ok}} years (pipeline.yearsOk, 5) never lower the score; only more than that counts (2026-09-23).
