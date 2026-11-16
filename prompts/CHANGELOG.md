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
- triage/v4 — location_ok is only about place (the model had set it false for "5+ years" or "no Three.js" and the role was
  rejected as a location problem); full-stack roles stay fullstack whatever the server language; years asks up to
  {{years_ok}} are never blockers; generous on stretch roles. Code now decides on one threshold, no borderline (2026-10-19).
- triage/v5 — new family java-fullstack: a full-stack role whose server side is Java (Java backend + React/Angular UI).
  v4 filed those under fullstack, whose CV hides all Java, while the java CV hides React — neither fit the
  role (2026-11-02).
- triage/v6 — new family devops (DevOps, SRE, platform, cloud): wanted roles.
  v5 filed them under other, so a Java-flavoured SRE job scored 38. Software titles are no blocker (2026-11-05).
- triage/v7 — generic software engineering roles are the candidate's roles too (2026-11-07). v6 rejected a
  Senior Software Engineer (Java, Python, C++) at 42 as "other" with "C++ required, never used", and
  an AI Engineer (Python/TypeScript agents) at 42 as "other". Now: an example list is met by any one item; a
  generic SWE posting takes the family of a language he has (no language named → fullstack); AI/LLM application work is
  software engineering; industry/domain never makes a role other; seniority/leadership asks are never blockers; an
  office in a commute city is no location problem. Re-screened: 58 and 72 (backend); Rust/Go roles still
  rejected. Code backs two of these up: decide() drops an on-site/hybrid blocker naming a commute city ("on-site in Prague
  office" had rejected a 58), and an "other" vacancy that names Java and no JS/TS gets the java CV.
- triage/v8 — Kotlin + Spring backends are java roles, and Kotlin there is an adjacent language to his Java + Spring Boot:
  never a blocker, scored as a stretch (55–69 when the rest matches). Kotlin for Android/mobile and Scala stay other.
  Remote anywhere in the EU/EEA/Europe includes Czechia, so the offices offered alongside it are no blocker (2026-11-11).
  v7 rejected a Kotlin / Spring Boot role at 40 with "primary language Kotlin" and "hybrid in Dubai or Madrid",
  although it said "remote anywhere in the EU". Code backs the location part up: decide() drops on-site/hybrid
  blockers when the listing offers remote across the EU or Europe (remoteInEurope in prefilter.ts).
- triage/v9 — requirement tiers (2026-11-12). v8 turned "a plus" items and job responsibilities into hard blockers: a
  Java Developer posting scored 48 with "low-latency trading systems / HPC background" and "MySQL/MongoDB as primary
  datastores", although the posting lists HPC, C/C++ and Go/Rust as "a plus" and names PostgreSQL next to MySQL and MongoDB.
  Now: only required items can be missing or blockers; optional wording ("plus", "nice to have", "preferred", "bonus",
  "familiarity") never lowers the score; responsibilities describe the job and are not entry tickets; a domain or specialty
  is no blocker by itself; interchangeable datastores are met by any SQL database in the profile. Re-screened:
  62 (java), no blockers. A dashboard (`npm start`) started before the switch kept serving v8's cached 48: it loaded
  config and prompts once at startup. It now reloads them (and profile, answers, .env) before every run and application.
- triage/v10 — new family fde (2026-11-12): forward deployed / client-embedded engineering roles whose daily work is
  writing production code at the customer. v9
  filed them by stack or under other. The missing FDE title is no blocker; pre-sales and support roles with little coding
  stay other. New feeds dou-fde and dou-fde-short; the fde CV keeps software job titles and adds no customer-facing duties.
- triage/v11 — a language the profile lists with commercial use is never "a primary language he never used" (2026-11-12).
  v10 scored an Applied AI Engineer (FDE) 48 on DOU and 40 on Djinni with "primary language Python (3+ years
  required)", although Python is in an engagement (1.5 commercial years) and a 3-year ask is within yearsOk. Code
  already dropped the blocker; the score still sat under the threshold. Now such a role is a stretch (55–69) when the rest fits.
- triage/v12 — a language the posting lets him learn on the job is not a missing primary language (2026-11-13). v11 scored
  a Software Engineer role (Prague) 48 as "other" with "primary development in Go", although the posting
  asks for "Proficiency in Python, Go, or another object-oriented programming language" plus willingness to master Go.
  Now such a role is a stretch (55–69) when the rest fits; a posting that requires existing
  experience in the language ("3+ years of Go") is still a miss. Code: decide()'s commute-city guard also reads
  "in-office in Prague" (it only knew "on-site", "hybrid" and "office", so the 48 was labelled a location reject).
  Re-screened: 58 (backend), no blockers.
- triage/v13 — Scala for Java engineers (2026-11-13): a Scala posting that says Java engineers may switch
  ("Java developers willing to switch to Scala", "strong Java or Scala") is a java role and a stretch (55–69), like Kotlin
  in v8; one that requires existing commercial Scala and offers no switch is still a miss and stays other. "Forward
  Deployment Engineer" added to the fde titles. Config, same day: FDE search feeds dou-fde-hyphen, dou-fde-deployment,
  djinni-fde and djinni-fde-short (Djinni's text search parameter is all_keywords; other spellings return every job),
  and Scala feeds dou-scala and djinni-scala so the Scala rule has postings to judge.
- tailor/v4 — a recruiter message with every CV (2026-11-15): recruiter_message.note (≤ pipeline.recruiterMessage.noteMaxChars,
  300: a LinkedIn connection request) and .message (≤ messageMaxChars, 700: a direct message). Product experience only —
  no thesis, university or personal projects, and none of skipEngagements; ownership shown through facts from the
  bullets; strengths only. Same grounding checks as the letter; over-long text loses whole trailing sentences before
  the length check. The message's closing line is fixed text added by code (recruiterMessage.closing): the model left it
  out in 3 of 4 trial messages. Saved as recruiter_message.txt in the pack and shown on the dashboard card with copy buttons.
