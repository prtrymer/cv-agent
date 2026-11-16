# cv-agent

Finds vacancies, screens them against a fact base, builds a CV + cover letter positioned for the role, and fills the
company's application form for you to review and submit. Everything it claims comes from `data/profile.yaml`;
everything it decides is logged.

**Status:** v0.2. Discovery (DOU, Djinni, company job boards, LinkedIn/Glassdoor alert emails) → prefilter → triage →
tailoring → application packs → report → assisted apply. It never submits an application itself.

## Everyday use: the dashboard

```bash
npm start
```

Opens `http://localhost:4870` in your browser (local only — nothing outside this Mac can reach it). From there:
**Find new vacancies** and **Write CVs** run the agent with live progress; every vacancy is listed by status with its
score, why it fits, and links to the posting, CV and cover letter; **Apply** opens the company's form filled in the
agent's browser window — questions it can't answer appear on the page — and you press Submit; **Preview fill** does it
invisibly and saves a screenshot; **Dismiss** / **Restore** / **Write CV anyway** / **I applied myself** manage the list.
The header shows OpenRouter credits left and what today and this month cost.

## Quick start

```bash
npm install
npx playwright install chromium   # PDF rendering and the apply browser (~150 MB, once)
npm run demo          # offline: fixture feeds + mock model, no key needed
cp .env.example .env  # then put your key in LLM_API_KEY
npm run doctor        # config, profile, prompts, model, cache, renderer, sources, working hours
npm run run           # the real thing
npm run run -- --source alerts       # only that source, end to end (also: watchlist, dou-node, …)
npm run cli -- add https://job-boards.greenhouse.io/acme/jobs/123   # any single posting
npm run cli -- add https://linkedin.com/jobs/view/123                      # LinkedIn, Jobs.cz, robota.ua: read from the public page/API
npm run cli -- add https://www.glassdoor.com/job-listing/j?jl=1 --file posting.txt   # Glassdoor/Indeed: paste the text
npm run apply                        # list ready packs
npm run apply -- greenhouse:acme:123 # fill that application form; you review and press Submit
npm run mark -- https://jobs.dou.ua/companies/acme/vacancies/123/ applied   # or dismissed | tailor | triage
npm test              # 54 tests (the browser ones need `npx playwright install chromium`)
```

Each run writes `out/packs/<date>__<id>__<company>-<role>/` with the CV (`<Name>_CV.html` + `.pdf`),
`<Name>_Cover_Letter.docx`, `cover_letter.txt` (for paste-in forms), `vacancy.md` (what the agent read)
and `decision.json` (role family, triage, plan, validation issues, prompt versions, models). The run summary lands in
`out/latest-report.md`. File names come from `person.name` and never say "tailored" — recruiters see them.
Every pack also has `recruiter_message.txt`: a pitch to send the recruiter directly — a connection note (≤ 300 characters) and a direct message (≤ 700), product experience only, limits in `pipeline.recruiterMessage`. The dashboard shows both on the card with Copy buttons.

`add` processes only the posting you give it; anything queued by earlier runs waits for the next `run`.
`--source` limits the whole run — discovery, screening and tailoring — to those sources; the rest of the queue waits.
Postings older than `pipeline.maxAgeDays` (14) are skipped before any model call.
`mark` records what you did (`applied`, `dismissed`) or sends a vacancy back through the pipeline (`tailor` = build a
pack anyway, e.g. for a rejected one; `triage` = score it again, e.g. after a prompt change).
`run --fresh` empties the state database; with a real model it moves the old one to `data/state.db.bak-<time>` first.

## Role families

Triage puts every posting in one family: **fullstack**, **frontend**, **backend** (Node.js/TypeScript), **java**,
**java-fullstack**, **devops** (DevOps, SRE, platform, cloud), **fde** (forward deployed / client-embedded engineering), or *other*. `pipeline.roleFamilies` in the config says which are in scope; anything else is rejected before tailoring.
Each family has its own positioning in `data/profile.yaml` → `positioning.families`: the CV headline
("Java Developer · Spring Boot / …"), the angle the summary and letter lead with, and the job title printed for each
engagement (the first title in the family's list that the engagement allows). Triage also sees commercial years per
technology, computed from engagement dates, so "3+ years of Java" is judged against Java years, not the total.

## Where vacancies come from

| Source | How | Config |
| --- | --- | --- |
| DOU, Djinni | RSS per category / keyword | `sources` |
| Company job boards | public job-board APIs of Greenhouse, Lever, Ashby, Workable, Recruitee, SmartRecruiters — no login, no scraping | `data/companies.yaml` |
| LinkedIn / Glassdoor / Indeed / Jobs.cz / Djinni / robota.ua | your **job-alert emails**, read over IMAP and listed as links, grouped by email — never screened | `alerts` |
| Anything else | `add <url>` (schema.org JobPosting) or `add <url> --file` | — |

A company board that lists one job once per city (same title and text, a new id per city) gives you
**one card**: before screening, postings with the same board, company, title and text fold into the row that got
furthest. The card links the other cities, and a ready one has an *Apply for … instead* button that uses the same CV on
that city's form. A city the free filters dropped never counts, and `add <link>` brings a folded posting back as its own.

Alert jobs are **links only** (since 2026-10-19): the model reads each email once to pick out the jobs (title,
company, place, link), and they are listed on the dashboard's *From job alerts* tab under the email they came in, with
**Open email** (opens it in Gmail by its Message-ID). No company-board lookup, no posting read, no screening — you open
the ones you like. A job you already applied to (tracking sheet) isn't listed; one at a company you applied to before
says so. *CV…* on a row takes the posting text you paste and screens it and writes the CV. A Djinni alert job the Djinni
feed already brought in stays with the feed and is screened there. Applying to a LinkedIn, Glassdoor or Indeed posting
always happens in your own browser (`apply.protectedBoards`). `add <linkedin or jobs.cz link>` still reads the public
posting logged out (`alerts.publicPages`). `add <robota.ua link>` reads the vacancy from `api.rabota.ua` (the site's
own pages are behind Cloudflare and are never opened; applying there happens in your browser too).

**Screening** has one line, `pipeline.applyThreshold` (50): at or above it a vacancy is shortlisted for your call,
below it rejected — there is no borderline. Rejections on location need a location-shaped reason, and years asks up to
`yearsOk` never block. Every run re-decides recent rejected verdicts under the current rules for free (no model call),
so changing the threshold reaches vacancies already screened.

**Setting up alerts (Gmail):** turn on 2-Step Verification, create an app password
(myaccount.google.com/apppasswords), put `IMAP_USER` / `IMAP_PASSWORD` in `.env`, create job alerts on LinkedIn and
Glassdoor (Java, Node.js, Frontend, Full-stack — Czechia and remote), then set `alerts.enabled: true`. The mailbox is
opened read-only: nothing is marked read, moved or deleted. Optional: a Gmail filter that labels the alerts, and that
label as `alerts.mailbox`.

**Company watchlist:** `data/companies.yaml`. Give `ats` + `board` when you know them, or just a `name` and the agent
looks it up across all six systems (and remembers the answer). Companies found through alert emails are looked up the
same way automatically.

## Applying

`npm run apply -- <id>` opens the posting's application form in a visible Chromium window (its own profile in
`data/browser-profile/`, not your Chrome) and fills it:

1. **Rules** from `answers.yaml` and `profile.yaml`: contact details, CV and cover-letter uploads, work authorisation
   (Czechia yes, other countries no), no visa sponsorship, no relocation, notice "Immediately", "how did you hear"
   from the source, years with a technology computed from engagement dates, required privacy consent ticked, talent
   pool / marketing boxes unticked, demographic questions "prefer not to say".
2. **Your earlier answers** to the same question (`answers.yaml` → `learned:`).
3. **The model**, for the rest: choices must be real options, prose must pass the same fact checks as the CV, and
   anything the material doesn't support (salary, dates, references…) comes back as unknown instead of a guess.
4. **You**, in the terminal, for required questions still open. Your answer is saved to `learned:` for next time.

Fields it couldn't fill are outlined in red. Check the form, fix anything, and press **Submit** yourself. The agent
watches for the confirmation page, then marks the vacancy applied and appends the link to `data/applied.txt`.
Everything it filled, with where each answer came from, is saved in the pack as `application.json` +
`application-form.png`. CAPTCHAs, logins and multi-page flows are yours; if no form is on screen it waits for you
to open it.

**Boards behind a bot check (We Work Remotely):** WWR's pages sit behind Cloudflare and its "Apply now" is locked
until you sign in. The agent's window is an automated browser, so Cloudflare's check fails there even when you click
it, and the agent never tries to get past it. For boards in `apply.protectedBoards`, the agent doesn't open the
posting in its window at all:

1. it looks the job up on the company's own board (Greenhouse, Lever, …), the same way it does for LinkedIn alerts;
2. if the job isn't there, it opens the posting in **your own browser** (signed in to WWR). Click "Apply now" (not
   "AI Auto-Apply") and paste the address it takes you to into the dashboard (or the terminal);
3. the agent opens that form in its window and fills it as usual. The link is remembered, so the next Apply or
   Preview goes straight there. `apply <id> --url <link>` sets or replaces it.

If "Apply now" gives an email address instead, the agent opens a draft in your mail app (cover letter as the body)
and the pack folder, so you can attach the CV and letter; you send it and press **I applied myself**. Any other
site that shows a bot-check page gets a few seconds to clear by itself; if it doesn't, the page opens in your
browser and the attempt stops. Nothing is submitted. `--simulate` fills headless and saves the screenshot without waiting — a dry run of the form.
Contact details are filled by code and never sent to the model.

## What lives where

| Path | What it is |
| --- | --- |
| `data/profile.yaml` | the fact base, bullet bank and role-family positioning — the only thing the agent may claim |
| `data/answers.yaml` | contact details, eligibility, logistics, consent policy, and `learned:` form answers |
| `data/companies.yaml` | company job boards read on every run |
| `data/base/cover_letter.md` | your base letter: fixed lines + slots, and the voice sample for the prompt |
| `data/applied.txt` | links already applied to; never applied to twice |
| `fixtures/profile/` | a fictional candidate (profile, answers, base letter) used by the tests and `npm run demo` — copy it to `data/` as a starting point |
| `config/agent.yaml` | mode, working hours, model, budgets, sources, alerts, apply, prefilter, renderer |
| `prompts/` | versioned prompts (triage, tailor, extract, answer); the hash is logged and is part of the cache key |
| `logs/` | `agent.log`, `llm/<day>.jsonl` (input, raw output, decision), `llm/prompts/<hash>.md` |

## Guardrails

The model never writes dates, employers, titles or contact details — code does, from the fact base. Its edit plan
is checked before anything is rendered:

- bullets must come from that engagement's bank; rewrites keep the problem — tools — outcome shape
- technologies must be in that engagement's stack; never-claim items are rejected anywhere
- thesis-only technology (a project's `academic_only` list) only in a sentence about that project
- numbers must exist in the fact base; years claimed can't exceed the real total
- the headline starts with the role family's headline; omitting engagements may not open a timeline gap
- positive-only: no gaps, no weaknesses, and never the word "tailored"
- the cover letter can't write its own greeting, signature or "CV attached" line
- alert extraction may only return links the email contains and names that appear in it
- form answers: real options only, grounded prose, "unknown" instead of a guess; you press Submit

A failed check is fed back once as a repair round; if it still fails, the pack is built but parked as *needs review*.

## Cost and failure handling

Prefilter first (free), then a short triage call, and tailoring only for matches. Job-board titles are filtered before
descriptions are downloaded. The system prompt and fact base are byte-stable so provider prefix caching applies, and a
Redis cache-aside (SQLite fallback) means an identical input never pays twice. Each alert email and each LinkedIn job
is processed once. Retries use exponential backoff with jitter and honour `Retry-After`; 4xx fails fast; every call
logs tokens, cost and latency; a daily budget and a circuit breaker stop the run rather than surprise you. The breaker
is per model, so a rate-limited extract model leaves screening running, and a stage with `fallbacks` switches to the next
model on a 429 instead of waiting minutes of `Retry-After`, or when its output is still invalid after the repair rounds.

## Next phase

1. Google Sheet: an *Agent Queue* tab and a *Questions* tab (ask-once answers), plus appending applied links to the main table.
2. Auto-submit per ATS once assisted runs on it have been clean, approval bound to the pack hash, working hours only.
3. Salary job: market median from matching vacancies every 14 days (salary questions are asked in person until then).
4. Daemon: scheduled runs inside working hours, Czech holidays skipped.

## Before the first real run

- Set `llm.baseUrl` / `stages.*.model` to the endpoint your key belongs to. `llm.pricing` is filled for mimo-v2.6-pro on
  OpenRouter — update it with the model, or the daily USD budget is computed from the wrong prices.
- `npx playwright install chromium` — `npm run doctor` shows the renderer it will use.
- Djinni keywords must match its list exactly (`React.js`, not `React`); an unknown keyword silently returns every job.
- Read `data/profile.yaml` end to end, including `positioning.families` and each engagement's `stack` (years per
  technology are computed from it). It is the only thing standing between you and a confident, wrong CV.
