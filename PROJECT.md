# jobscout

**A single-binary CLI that searches nineteen job engines at once, ranks every posting by how many of your actual skills it asks for, drafts the paperwork, and leaves the submit button to you.**

- **Runtime:** Bun + TypeScript, compiled to one executable
- **Store:** SQLite for state, Markdown for drafts
- **AI:** headless Claude Code — no API key, no per-token cost
- **Setup:** one command
- **Status:** specification complete, awaiting build

---

## Table of contents

1. [What it is](#1-what-it-is)
2. [Principles](#2-principles)
3. [The one command](#3-the-one-command)
4. [Command surface](#4-command-surface)
5. [The pipeline](#5-the-pipeline)
6. [Engines — where jobs come from](#6-engines--where-jobs-come-from)
7. [Skill matching — the ranking engine](#7-skill-matching--the-ranking-engine)
8. [What the AI does](#8-what-the-ai-does)
9. [Data model](#9-data-model)
10. [Project structure](#10-project-structure)
11. [Stack](#11-stack)
12. [Build order](#12-build-order)
13. [Out of scope](#13-out-of-scope)
14. [Open decisions](#14-open-decisions)

---

## 1. What it is

jobscout runs a job search end to end from your terminal.

You give it your résumé. It parses that into a structured map of what you can actually do — every skill, its category, how long you have used it, and the line from your résumé that proves it. Then it searches nineteen job engines in parallel and measures every posting it finds against that map, ordering your list by how many of your skills each role genuinely asks for, with the count shown next to every row.

For the roles that clear the bar it drafts a tailored cover letter and screening answers, then hands you a full-screen terminal interface to approve or reject each one in seconds. When you approve something it finalises the materials, opens the posting in your browser with the cover letter already on your clipboard, and waits. **You** fill the form, **you** review it, **you** click submit. Afterwards it remembers what you sent and when, and tells you which applications have gone quiet.

It runs entirely on your machine. No server, no account, no subscription, no data leaving your laptop except the calls that fetch public job listings.

---

## 2. Principles

Six commitments that decide arguments later.

| Principle | What it means in practice |
|---|---|
| **You press submit** | Nothing auto-applies. Enforced structurally, not by policy: *no browser-automation library appears anywhere in the dependency tree*, so the tool is physically incapable of filling or submitting a form. |
| **Fetching is dumb, thinking is smart** | Engines do one job: retrieve and hand back raw records. Every judgement happens in a separate layer above them. A broken engine is an engine bug, never an AI bug. |
| **Prefer published interfaces** | Default sources are documented APIs meant to be consumed. Scraping is opt-in, clearly labelled, never default. Sources that gate access behind CAPTCHA are not worked around. |
| **No key, no cost** | The AI is your existing Claude Code session. There is no `ANTHROPIC_API_KEY` and no per-token bill. |
| **One binary, one command** | Install is downloading a file. Setup is running `jobscout init`. Nothing else. |
| **Your data stays legible** | Drafts are plain Markdown you can read, diff, and edit. State is one SQLite file you can copy, back up, or delete. |

---

## 3. The one command

```bash
jobscout init
```

**This is the only setup step, and it is the only maintenance step.** There is no separate `doctor`, no `setup`, no `install`, no `configure`. `init` is *idempotent*: run it the first time and it builds everything; run it again in three months and it re-checks everything, skips what is healthy, and repairs what is not. Same command, same code path.

### What it does, in order

**Phase 1 — Environment**
- Verifies the binary matches your platform and architecture
- Creates the data directory and confirms it is writable
- Migrates the database schema to the current version

**Phase 2 — Dependencies**
- Detects Claude Code and confirms it is authenticated
- Detects Python 3.10+ **only if** you choose to enable the JobSpy engine
- Anything missing is reported in plain language with an offer to fix it

**Phase 3 — Your profile**
- Asks for your résumé, extracts the text, and shows a preview so you can judge the extraction quality
- Builds your skill graph and shows it to you for correction
- Asks for target roles, locations, salary range, notice period, and sponsorship status

**Phase 4 — Engines**
- Enables all fifteen keyless engines automatically
- Offers the keyed ones, opening each signup page if you say yes
- Offers JobSpy with an honest description of the trade-off

**Phase 5 — Boards**
- Uses AI board discovery to find companies matching your profile on Greenhouse, Lever, Ashby and the rest
- Verifies every discovered token resolves before saving it

**Phase 6 — Verification**
- Runs a real fetch against every enabled engine
- Runs a real skill match against a sample of what came back
- Confirms drafting works end to end

Only after phase 6 passes does it report ready.

### What it looks like

```
$ jobscout init

  ENVIRONMENT
  ✓ jobscout 1.0.0 · macOS arm64
  ✓ Data directory        ~/jobscout
  ✓ Database              schema v1, fresh

  DEPENDENCIES
  ✓ Claude Code           authenticated as you@example.com

  YOUR PROFILE
  ? Résumé file?          ~/Downloads/varun_cv.pdf
  ✓ Extracted 492 words. Preview looks clean.
  ✓ Found 38 skills across 6 categories.
      Strongest: payments · Java · SQL · PostgreSQL · API design
  ? Review them now?      [Y/n]

  ? Target roles?         senior backend, payments
  ? Where?                Remote (India), Chennai
  ? Salary range?         INR 20L – 60L
  ? Notice period?        1 month
  ? Need sponsorship?     no

  ENGINES
  ✓ Enabled 15 keyless engines
      Greenhouse · Lever · Ashby · Recruitee · Workable · SmartRecruiters
      RemoteOK · Arbeitnow · The Muse · Remotive · Himalayas · Jobicy
      Hacker News · Foundit · Instahyre

  ? Adzuna + Careerjet — free keys, ~2 min. Open signup pages?   [Y/n] y
  ✓ Both keys saved to secrets.toml (mode 600)

  ? JobSpy — reaches Indeed + LinkedIn, 42% of a typical corpus.
    Needs Python 3.10+; scrapes rather than asks; breaks sometimes. [y/N] y
  ! Python not found.
    Install with Homebrew? This needs your password, so I will
    print the command rather than run it:
        brew install python@3.12
  ? Retry once installed, or skip for now?                      [retry/skip] skip
  ○ JobSpy left disabled. Re-run `jobscout init` to enable it later.

  BOARDS
  ✓ Discovered 34 company boards matching your profile
  ✓ 31 verified live, 3 dropped as stale

  VERIFICATION
  ✓ 16 engines responded          412 postings fetched
  ✓ Skill matching                sample of 20 matched cleanly
  ✓ Drafting                      test letter generated

  Ready. Run `jobscout run`.
```

### Re-running it later

```
$ jobscout init

  ✓ Environment, dependencies, profile      unchanged
  ! Résumé changed since last run — re-extract?                 [Y/n] y
  ✓ Skill graph rebuilt: 38 → 41 skills (+Kafka, +gRPC, +Terraform)
  ! Adzuna key rejected — free tier resets in 6 days
  ○ 3 board tokens no longer resolve — removed
  ✓ 16 engines healthy

  Ready.
```

### Flags

| Flag | Effect |
|---|---|
| `--yes` | Accept every default; no prompts. For scripted setup. |
| `--repair` | Skip all questions, only detect and fix what is broken. |
| `--reset` | Start over. Prompts before deleting anything. |
| `--dry-run` | Report what it would do; change nothing. |

### What it will never do

Install anything without asking first, and never anything requiring your password. Where a fix needs `sudo` or an admin prompt, jobscout prints the exact command and waits for you to run it yourself.

---

## 4. Command surface

```
jobscout init       Set up, verify, and repair everything — the only setup step
jobscout skills     Show, edit, or re-extract your skill profile
jobscout discover   Fetch new postings from every enabled engine
jobscout boards     Find and manage company ATS boards to watch
jobscout match      Rank postings by skill overlap with your profile
jobscout score      AI second opinion on what the counts can't see
jobscout draft      Write cover letter + screening answers per job
jobscout review     Full-screen triage — approve / reject by keystroke
jobscout prepare    Finalise approved jobs into the outbox
jobscout apply      Open each job, stage its materials, you submit
jobscout status     Where everything stands; what's gone stale
jobscout run        discover → match → score → draft, in one go
jobscout export     CSV or JSON out, for spreadsheets or backup
```

In practice a normal day is two commands: `jobscout run`, then `jobscout review`.

---

## 5. The pipeline

Data flows one direction and never backwards. Each stage reads the previous stage's output from SQLite and writes its own, so any stage can be re-run in isolation.

```
STAGE 0 — profile          runs once, then only when your résumé changes
  résumé  →  structured skill graph


STAGE 1  discover     every enabled engine fetches in parallel
STAGE 2  normalise    AI · salary, seniority, real remote status
STAGE 3  dedupe       AI · collapse the same role posted five times
STAGE 4  extract      AI · pull required and preferred skills from the posting
STAGE 5  match        ── the ranker · arithmetic, not opinion ──
STAGE 6  score        AI · judge what skill counts cannot see
STAGE 7  draft        AI · cover letter + screening answers
STAGE 8  review       YOU · approve or reject in the TUI
STAGE 9  apply        YOU · fill, review, and submit the form
```

**Stage 5 is deliberately not AI.** Once stage 4 has pulled a skill list out of the posting, deciding how well you fit is set intersection — count what matched, count what did not, divide. That makes the ordering of your job list auditable: every position is a number you can see the working for, not a model's opinion you have to trust.

Matching is free and instant, so nothing is discarded before it has been measured. Only jobs clearing the match threshold reach stages 6 and 7, where the expensive work happens.

---

## 6. Engines — where jobs come from

**No single engine is the source of truth.** Nineteen engines across five families, all implementing one interface, all running in parallel, results converging into one deduplicated pool. Fifteen need no key at all. Every endpoint below was called live during specification.

### Family A · Applicant tracking systems — keyless, full descriptions

| Engine | Status | Notes |
|---|---|---|
| Greenhouse | verified | 583 jobs, 4,945-char descriptions, one keyless request |
| Lever | verified | resolved Meesho and CRED — real India coverage |
| Ashby | verified | keyless GraphQL board endpoint |
| Recruitee | verified | per-company offers API |
| Workable | live | public widget API per account |
| SmartRecruiters | live | public postings API per company |

Best data in the system: complete descriptions, direct apply URLs, and — being published interfaces rather than scraped pages — they do not break. Their one weakness is that you must know which company uses which platform, which is what board discovery solves.

### Family B · Job boards — keyless, searchable

| Engine | Live check | Covers |
|---|---|---|
| RemoteOK | 100 jobs | Remote-first, global, strong engineering density |
| Arbeitnow | 175 jobs | Europe-weighted, visa-sponsorship flags |
| The Muse | 20 jobs | Mid-to-large companies, structured levels |
| Remotive | 18 jobs | Curated remote roles, full descriptions |
| Himalayas | working | Remote, good timezone metadata |
| Jobicy | working | Remote, region-filterable |
| Hacker News | working | *Who is hiring* threads via the Algolia API |

### Family C · India

| Engine | Status | What it returns |
|---|---|---|
| **Foundit** *(ex-Monster India)* | verified | **A pre-extracted `skills` array plus `skillsWithSynonyms`** — consumable by the match stage directly, no AI extraction needed. Also salary range, experience range, industry, function. |
| Instahyre | 13,595 jobs | India engineering-focused. Title, company, locations, keywords, public URL. Descriptions need a per-job fetch. |
| ~~Naukri~~ | **blocked** | Search API returns `recaptcha required` to every request. See below. |

Foundit is the more valuable by some distance. Every other engine hands over prose that stage 4 must spend an AI call parsing into skills; Foundit hands the skill list over already structured, *with synonyms* — exactly what the alias map needs.

> **Why Naukri is absent.** Naukri's search API responds `{"message":"recaptcha required"}` to every request. Verified against the current signed header, mobile application IDs, referer spoofing, and an unauthenticated call — all four refused identically. This is also why JobSpy's Naukri scraper returns zero across every location and search term tested: the code is fine, the door is shut.
>
> **Working around a CAPTCHA gate is out of scope, permanently.** It is the clearest possible statement that automated access is unwelcome. There is therefore no supported route to Naukri, and jobscout does not claim one — see "Out of scope".

### Family D · Keyed aggregators — breadth, free tiers

| Engine | Key | Description quality | Role |
|---|---|---|---|
| Adzuna | Free, instant · ~1k/mo | snippet | 19 countries including India; good salary data |
| Careerjet | Free | snippet | 90+ countries, `en_IN` locale |
| Jooble | Free, per country | snippet | Needs a separate key per regional domain |

### Family E · Scraper — opt-in only

| Engine | Setup | Reaches | Trade-off |
|---|---|---|---|
| JobSpy | Python sidecar | **Indeed, LinkedIn** | The only route to Indeed India and LinkedIn — together 42% of a typical corpus — and the only source that can break without warning. Its Naukri, Glassdoor, Google and ZipRecruiter scrapers all return zero and are not counted. Off by default. |

### How the families cover for each other

They have complementary failure modes, which is the whole argument for running all of them. ATS boards have perfect data but a discovery problem. Aggregators find anything but return a headline and a redirect. Remote boards are excellent for remote-first roles and blind to everything else.

So the families relay. **An aggregator discovers that a role exists; an ATS engine goes and gets the real thing.** When a posting arrives with a truncated description, the pipeline checks whether that company has a known board and re-fetches the full text from source — turning a snippet into something the match stage can work with.

Every engine records the outcome of every run — fetched, inserted, errored, rate-limited — and `jobscout status` shows the roster.

---

## 7. Skill matching — the ranking engine

Your résumé is not just context handed to a model when it writes a cover letter. It is parsed once into a structured skill graph, and that graph is what every job is measured against.

### Step one — your résumé becomes a skill graph

```
$ jobscout skills

Your skill profile  ·  extracted from varun_cv.pdf  ·  38 skills

LANGUAGE     Java 7y strong   Python 4y strong   Go 2y working   SQL 7y strong
DATASTORE    PostgreSQL 6y strong   Redis 3y working   Oracle 2y working
DOMAIN       Payments 6y expert   Ledgers 4y strong   Settlement 3y working
             Card networks 3y working   PCI compliance 2y exposure
PRACTICE     Distributed systems 5y strong   API design 6y strong
CLOUD        AWS 4y working   Docker 4y working   Kubernetes 1y exposure

Evidence for "Payments · expert":
  "Fiserv online transaction integration (L3 support): built the online
   integration with Fiserv (authorization, …)"

$ jobscout skills --add kafka --years 1 --level exposure
$ jobscout skills --remove wordpress
```

Each skill carries a category, duration, strength, and **the résumé line that proves it** — so nothing is invented. The profile is editable, because résumés understate things, and edits survive re-extraction.

### Step two — every posting is parsed the same way

Stage 4 pulls a skill list out of each description and splits it into **required** and **preferred**, because "must have" and "nice to have" should not count the same. Both sides normalise to the same canonical vocabulary, so `Postgres`, `PostgreSQL` and `psql` resolve to one entry and a real match is never missed on spelling. The alias map is a local file that grows as new spellings appear.

### Step three — the overlap is counted

```
Affirm — Senior Software Engineer, Payments Infrastructure

  Required matched   9 / 11   ████████████████████░░░░  82%
  Preferred matched  3 / 5    ████████████░░░░░░░░░░░░  60%

  ✓ matched    Go · PostgreSQL · payments · ledgers · distributed systems
               API design · settlement · SQL · AWS
  ✗ missing    Kafka (required) · Terraform (required)
  + bonus      Java · card networks · PCI compliance
               — strengths they did not ask for; useful in the letter

  match score  0.84   rank 1 of 71
```

The composite is transparent and tunable — weights live in your config:

```
match_score = 0.60 × required_coverage     weighted by your depth in each skill
            + 0.20 × preferred_coverage
            + 0.15 × seniority_fit          your level vs the role's
            + 0.05 × domain_affinity        payments, fintech, infra
```

A required skill you hold at *expert* contributes more than the same skill at *exposure*. Missing a required skill you have never touched costs more than missing one you have seen.

Because this is arithmetic rather than judgement, three things follow: the ordering is **reproducible**, it is **explainable**, and it is **free** — so every posting gets measured rather than sampled.

The AI score from stage 6 sits *alongside* this, never replacing it. It catches what counting cannot: a role that matches your skills but is a step backwards, a description full of red flags, a company whose stage does not suit you. Sort by either; where they disagree, that disagreement is itself informative.

### A useful side effect

```
$ jobscout skills --gaps

Most-demanded skills you don't have   across 412 postings seen

  Kafka          ████████████████████  61 jobs  ·  ~14% of your matches
  Kubernetes     ██████████████        43 jobs  ·  you have 1y exposure
  Terraform      ███████████           34 jobs
  gRPC           ████████              24 jobs

Learning Kafka would move 61 postings up your list.
```

One query over data the pipeline already holds — and the most concrete career signal the tool can give you.

---

## 8. What the AI does

Six jobs, across whichever backend is available. None of them fetch anything, and none of them decide your ranking.

| Job | Runs | Produces |
|---|---|---|
| **Profile skills** | Setup and résumé change | Your résumé parsed into canonical skills with category, duration, strength, and proof |
| **Normalise** | Per new posting | Structured salary, seniority, employment type, and a real remote verdict — catching roles that say "remote" in the title and "must reside in the US" in paragraph four |
| **Dedupe** | Per discovery run | Groups near-identical postings and marks one canonical |
| **Extract skills** | Per posting | Required and preferred skills, normalised to the same vocabulary as your profile |
| **Score** | Per job above match threshold | A 1–5 judgement of what skill counts miss, with reason and concerns |
| **Draft** | Per job above threshold | `cover_letter.md`, `answers.md`, `resume_notes.md` |

Board discovery is deliberately *not* on this list. It was specified as an AI job and built without one: most companies use their own name as the board token, so probing candidates against each platform resolves the majority for free. Vercel, Celonis, Graphcore and Meesho were all found that way.

**Where the line sits.** The AI does the *fuzzy* work — reading prose and turning it into structure. The *consequential* work, deciding which jobs you see first, is arithmetic over that structure. If a ranking looks wrong you inspect the skill lists that produced it and correct them, rather than re-prompting a model and hoping.

**Deliberately not built:** an AI agent that browses job sites. Slow, expensive, breaks constantly, and is bot traffic against the same sites — reintroducing exactly what the published-interfaces principle exists to avoid.

### Backends

Seven, behind one interface, tried in order until one is available:

```
claude-code → codex-cli → gemini-cli → ollama        (the default chain)
anthropic · openai · gemini                          (paid, opt-in only)
```

Agent CLIs come first because each spends a subscription already held rather than charging per call; Ollama is free and local. **No paid provider appears in the default**, and a test asserts it. A missing CLI or unset key falls through rather than failing the run, so the chain degrades quietly.

The chain is a *preference*, not a record of what is installed. A scripted run that finds nothing leaves it intact, so installing a backend later is enough on its own.

### Cost

Models are chosen by task rather than by budget pressure:

| Tier | Runs | Wants |
|---|---|---|
| `extract` | ~120× per discovery | structured extraction — a small or local model is adequate |
| `judge` | per job above threshold | judgement |
| `write` | a handful | writing quality, which is the entire point |

That saves money on every run, not only once a limit is reached, and spends what budget exists where it shows.

The limit is enforced **at stage boundaries**, sized by the whole stage. Stopping mid-stage would leave some jobs drafted and others not, with no record of which — so a stage that would cross the limit is not started at all.

Every figure is an estimate and is recorded as one. Each call stores whether its cost was `reported` by the provider, `derived` from a price table, or `free`. A model with no known price counts as unpriced rather than as zero, and `status` surfaces that so a total is never read as complete when it is not. Even the best case is approximate: Claude Code reports `total_cost_usd`, and its own documentation calls that a client-side estimate that can differ from the actual bill.

---

## 9. Data model

One SQLite file holds all state. Drafts stay as Markdown on disk. SQLite is embedded in Bun, so it adds no dependency and no daemon.

### Tables

```
jobs            id · engine · company · title · location · remote
                apply_url · description · description_complete
                salary_min/max/currency/period · seniority
                posted_at · first_seen · last_seen · raw (JSON)
                canonical_id · review_status

profile_skills  skill (canonical) · label · category · years
                level · evidence · source · pinned

job_skills      job_id · skill · label · requirement (required|preferred)

skill_aliases   alias · canonical            "psql" → "postgresql"

matches         job_id · matched_required · total_required
                matched_preferred · total_preferred · coverage
                match_score · matched · missing · bonus (JSON)

scores          job_id · ai_score (1–5) · reason · concerns · model

applications    job_id · status · submitted_at · last_status_at · note

boards          company · ats · token · verified_at · active

engine_runs     engine · started_at · status · fetched · inserted · error

answers         question · answer · confirmed_at · times_used
```

`matches` is what your job list is sorted by. It stores the counts, not just the composite, so the TUI can show the working and you can re-sort by coverage, raw match count, or AI score without recomputing.

`engine_runs` exists so a broken source is never indistinguishable from an empty one.

### Two status tracks, kept separate

```
Triage — lives on the job
  new → scored → drafted → approved │ rejected │ auto_skipped

Application — created only when approved
  prepared → submitted → responded → interviewing → offer
                      ↘ closed      ↘ ghosted
```

Keeping them apart means rejecting a job never touches application history, and an application's progress never rewrites the triage record of why you approved it.

### On disk

```
~/jobscout/
├── jobscout.db              all state
├── config.toml              preferences — safe to share
├── secrets.toml             engine keys — mode 600, never shared
├── profile/
│   ├── resume.pdf           the file you actually upload
│   ├── resume.extracted.md  generated text the AI reads
│   ├── skills.toml          your skill graph — editable, survives re-extraction
│   ├── aliases.toml         skill spellings, grows over time
│   ├── work-history.md      bullets beyond what fits on the résumé
│   └── cover-letter-style.md
├── drafts/{job_id}/         cover_letter.md · answers.md · resume_notes.md
└── outbox/{job_id}/         finalised, ready to submit
```

---

## 10. Project structure

```
jobscout/
├── README.md
├── PROJECT.md                      this file
├── LICENSE
├── package.json
├── tsconfig.json
├── bunfig.toml
├── .gitignore
├── .github/
│   └── workflows/
│       ├── ci.yml                  typecheck, lint, test
│       └── release.yml             cross-compile binaries, attach to release
│
├── src/
│   ├── index.ts                    entry point, command dispatch
│   │
│   ├── cli/                        one file per command — arg parsing only,
│   │   ├── init.ts                 no business logic lives here
│   │   ├── skills.ts
│   │   ├── discover.ts
│   │   ├── boards.ts
│   │   ├── match.ts
│   │   ├── score.ts
│   │   ├── draft.ts
│   │   ├── review.ts
│   │   ├── prepare.ts
│   │   ├── apply.ts
│   │   ├── status.ts
│   │   ├── run.ts
│   │   └── export.ts
│   │
│   ├── setup/                      everything `jobscout init` does
│   │   ├── init.ts                 orchestrates the six phases
│   │   ├── checks/                 each check owns its own detect + fix
│   │   │   ├── check.ts            the Check interface
│   │   │   ├── environment.ts      platform, data dir, permissions
│   │   │   ├── database.ts         schema version, migrations
│   │   │   ├── claude-code.ts      presence and auth
│   │   │   ├── python.ts           only when JobSpy is enabled
│   │   │   ├── resume.ts           exists, extractable, not a scan
│   │   │   ├── skill-profile.ts    built, non-empty, not placeholder
│   │   │   ├── engine-keys.ts      present and accepted
│   │   │   └── boards.ts           tokens still resolve
│   │   ├── wizard/                 the interactive questions
│   │   │   ├── profile.ts
│   │   │   ├── preferences.ts
│   │   │   └── engines.ts
│   │   └── verify.ts               phase 6 — real fetch, real match, real draft
│   │
│   ├── engines/
│   │   ├── engine.ts               the interface every engine implements
│   │   ├── registry.ts             enable/disable, parallel execution, health
│   │   ├── ats/
│   │   │   ├── greenhouse.ts
│   │   │   ├── lever.ts
│   │   │   ├── ashby.ts
│   │   │   ├── recruitee.ts
│   │   │   ├── workable.ts
│   │   │   └── smartrecruiters.ts
│   │   ├── boards/
│   │   │   ├── remoteok.ts
│   │   │   ├── arbeitnow.ts
│   │   │   ├── themuse.ts
│   │   │   ├── remotive.ts
│   │   │   ├── himalayas.ts
│   │   │   ├── jobicy.ts
│   │   │   └── hackernews.ts
│   │   ├── india/
│   │   │   ├── foundit.ts
│   │   │   └── instahyre.ts
│   │   ├── aggregators/
│   │   │   ├── adzuna.ts
│   │   │   ├── careerjet.ts
│   │   │   └── jooble.ts
│   │   └── scraper/
│   │       ├── jobspy.ts           subprocess bridge
│   │       └── sidecar/            venv bootstrap, pinned requirements
│   │
│   ├── skills/
│   │   ├── profile.ts              résumé → skill graph
│   │   ├── extract.ts              posting → required/preferred skills
│   │   ├── canonical.ts            the canonical vocabulary
│   │   ├── aliases.ts              alias map load, lookup, grow
│   │   └── match.ts                the ranker — pure functions, heavily tested
│   │
│   ├── ai/
│   │   ├── client.ts               headless Claude Code wrapper
│   │   ├── schemas.ts              zod schemas for every AI response
│   │   └── prompts/                versioned, reviewable, diffable
│   │       ├── profile-skills.md
│   │       ├── normalise.md
│   │       ├── dedupe.md
│   │       ├── extract-skills.md
│   │       ├── score.md
│   │       ├── draft.md
│   │       └── discover-boards.md
│   │
│   ├── pipeline/
│   │   ├── pipeline.ts             stage orchestration, resumable
│   │   ├── normalise.ts
│   │   ├── dedupe.ts
│   │   ├── enrich.ts               snippet → full text via ATS relay
│   │   └── stages.ts
│   │
│   ├── db/
│   │   ├── schema.sql
│   │   ├── migrations/
│   │   ├── queries.ts              typed query helpers
│   │   └── db.ts                   connection, transactions
│   │
│   ├── tui/
│   │   ├── review.tsx              the Ink app root
│   │   ├── components/
│   │   │   ├── JobList.tsx
│   │   │   ├── SkillBreakdown.tsx
│   │   │   ├── DescriptionPane.tsx
│   │   │   ├── DraftPane.tsx
│   │   │   └── StatusBar.tsx
│   │   └── keybindings.ts
│   │
│   ├── output/
│   │   ├── table.ts                aligned static tables
│   │   ├── progress.ts             spinners, per-engine progress
│   │   └── theme.ts                colour, TTY detection
│   │
│   ├── config/
│   │   ├── schema.ts               zod config schema
│   │   ├── load.ts
│   │   ├── secrets.ts              separate file, mode 600
│   │   └── paths.ts
│   │
│   └── util/
│       ├── hash.ts                 stable job ids
│       ├── clipboard.ts            cross-platform
│       └── browser.ts              open a URL
│
├── tests/
│   ├── fixtures/                   recorded responses, one per engine
│   ├── engines/                    contract tests — every engine, same suite
│   ├── skills/                     match arithmetic, alias resolution
│   └── setup/                      check detection and repair
│
└── scripts/
    ├── record-fixtures.ts          refresh recorded engine responses
    └── build.ts                    cross-compile release binaries
```

### Notes on the layout

- **`cli/` holds no logic.** Each file parses arguments and calls into a service. This keeps commands thin and makes the same operations callable from `run.ts` without shelling out.
- **Every engine is one file** implementing one interface. Adding a source is adding a file and registering it. Deleting one is deleting a file.
- **`skills/match.ts` is pure functions.** No I/O, no AI, no database — which is what makes the ranking testable and reproducible.
- **Prompts are versioned files, not inline strings.** A change to how jobs are scored shows up in a diff and gets reviewed like any other code.
- **Engine tests share one contract suite.** Every engine runs the same tests against recorded fixtures, so a new engine cannot ship half-implemented.

---

## 11. Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun** | ~15 ms cold start, and `bun build --compile` emits a single executable — what makes the one-command install possible |
| Language | **TypeScript** | Strict mode; services as classes with constructor injection |
| CLI parsing | **citty** or **commander** | Small, no decorator metadata, no startup cost |
| TUI | **Ink** | React for the terminal; makes a split-pane interface with live preview tractable |
| Static output | **picocolors · cli-table3 · ora** | Degrades correctly when piped or run without a TTY |
| Prompts | **@clack/prompts** | The wizard and every fix; handles cancellation and non-interactive mode |
| Database | **bun:sqlite** | Built into the runtime — no dependency, no native compilation, no daemon |
| Validation | **zod** | Config, engine responses, and AI output. Anything crossing a boundary is parsed, not trusted |
| Clipboard | **clipboardy** | macOS, Linux, Windows |
| Mail | **imapflow** | Alert inbox engine only |
| AI | **Claude Agent SDK** / headless `claude -p` | Uses existing Claude Code auth — no API key, no per-token cost |

---

## 12. Build order

Each phase ends somewhere usable.

| Phase | Deliverable |
|---|---|
| **1 · Skeleton** | Bun project, CLI scaffolding, SQLite schema and migrations, config with validation, the check registry. Ends with `jobscout init` working end to end against an empty system. |
| **2 · Engines** | The engine interface, then the six ATS platforms against recorded fixtures, then the seven keyless boards, then Foundit and Instahyre, then the keyed aggregators. Ends with `jobscout discover` filling the database from every source in parallel. |
| **3 · Skills and matching** | Résumé to skill graph, canonical vocabulary and alias map, per-posting skill extraction, the deterministic match. Ends with `jobscout skills` and a job list ranked by real overlap — the heart of the tool. |
| **4 · Judgement and drafting** | Normalise, dedupe, snippet enrichment, AI scoring, letter drafting. Ends with `jobscout run`. |
| **5 · Triage** | The Ink review interface — list, skill-breakdown pane, keybindings, search, filter, re-sort, notes. Ends with the full loop from discovery to approved. |
| **6 · Last mile and tracking** | `prepare`, `apply`, `status`, the answer bank, staleness query, skill-gap analysis. Ends with the complete workflow. |
| **7 · Ship** | Board discovery, cross-platform release builds, documentation, licence. Optionally the JobSpy plugin. |

**One measurement is scheduled.** At the end of phase 2, run real search terms — senior backend, payments, remote India — through the nineteen non-scraping engines and count what comes back. That number decides whether JobSpy gets built at all, rather than guessing now.

---

## 13. Out of scope

Named explicitly so they do not creep in.

- **Anything that submits a form.** Permanent, not a v1 deferral.
- **Defeating CAPTCHA or bot-detection.** Permanent. This is why Naukri's API is absent.
- **Any access to your email.** No IMAP, no OAuth, no mailbox permission. An alert-inbox engine was designed and deliberately dropped: it would have been the heaviest permission in the tool, and unscoped app passwords grant full mailbox access — a poor trade for snippet-only job cards. The cost of this decision is that **Naukri is unreachable**, and jobscout says so rather than pretending otherwise.
- **Interview scheduling, contacts, reminders.** Status tracking stops at one column and a staleness query. Beyond that is a CRM.
- **A web interface.** The TUI is the interface.
- **Multi-user or hosted anything.** Single user, single machine, local file.
- **Résumé generation.** Your PDF stays the source of truth; the tool suggests which bullets to emphasise and never rewrites the document.
- **Paid data providers.** The interface accommodates them; none ship.

---

## 14. Open decisions

Settled:

| | |
|---|---|
| Runtime | Bun + TypeScript, single binary |
| AI | Headless Claude Code — no API key |
| Ranking | Deterministic skill-overlap counting; AI scoring is a second signal, never the ranker |
| Engines | Nineteen across five families; fifteen keyless |
| Interface | Ink TUI for review; polished static output elsewhere |
| Storage | SQLite for state, Markdown for drafts |
| Tracking | Minimal lifecycle plus staleness query — not a CRM |
| Setup | One idempotent `init`; no separate doctor |
| Licence | MIT |
| Mail access | Never. No IMAP, no OAuth, no mailbox permission of any kind |
| Name | `jobscout` — binary `jobscout`, optional `scout` alias |
| Provenance | Fresh repository, original prose, new licence |

Needing your confirmation:

1. **Engine roster** — all nineteen ship; JobSpy prominently offered but off by default.
2. **Config location** — one portable `~/jobscout/` folder, keys split into `secrets.toml` at mode 600. Alternative is XDG directories: more standard, harder to back up.
3. **Distribution** — GitHub release binaries for macOS, Linux and Windows as primary, npm package as secondary.
4. **Manual import** — a zero-permission way to add a posting you found yourself (see below). Worth building?
