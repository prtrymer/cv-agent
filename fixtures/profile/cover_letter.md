<!--
fixtures/profile/cover_letter.md — the FICTIONAL candidate's base letter (tests and `npm run demo`).
Your real one lives in data/base/cover_letter.md (gitignored) and has the same layout.
[fixed]  inserted by code, word for word
[slot]   written per vacancy from profile.yaml, in this voice, under the same checks as the CV
The sample text inside the slots shows tone and rhythm only; its facts come from profile.yaml per vacancy.
Email channels get the Subject line; application forms drop it.
-->

Subject: {{vacancy_title}} — Alex Doe                                            [fixed, title filled by code]

Hi!                                                                              [fixed]

[slot: intro — one sentence: who, years, the role by its name]
I'm Alex — a fullstack developer with 3+ years of experience across TypeScript, Elixir and Java, and I'd love to be considered for the Fullstack role

[slot: snapshot — "Quick snapshot:" the one or two engagements that match this posting best]
Quick snapshot: a year of end-to-end fullstack work on a TypeScript product platform (React + NestJS, Redis, PostgreSQL, hexagonal architecture), and currently frontend on a multi-market grocery marketplace — a large production React + TS codebase I'm helping migrate to React 19.

[slot: before — "Before that:" supporting engagements, ending on a one-line punch]
Before that: a year on an Elixir microservice platform (Phoenix, Ecto, OTP — database migrations, Protobuf contracts and gRPC stubs across several services), and a commercial Java product where I built the test suite with JUnit, Mockito and Testcontainers plus a JSoup scraper. So "picks up new stacks quickly" isn't a claim — it's most of my track record.

[slot: proof — optional: thesis, first shipped product, or the story closest to the posting]
For my thesis I built a forecasting system on Kafka + ScyllaDB with a React dashboard, so event-driven backends don't scare me. And the first thing I ever shipped — a student platform on NestJS and Prisma — is still in production, serving up to ~500 concurrent users.

CV attached; code at github.com/alex-doe-example. Happy to chat!                 [fixed]

Alex Doe                                                                         [fixed]

<!--
Ukrainian-language postings get a Ukrainian letter (CV stays English). Fixed lines for those:
  greeting: Вітаю!
  closing:  CV у вкладенні, код — github.com/alex-doe-example. Буду радий поспілкуватися!
  signature: Alex Doe
-->
