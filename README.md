# jobscout

Search nineteen job engines at once, ranked by how many of your actual skills each role asks for.

You give jobscout your résumé. It parses that into a structured map of what you can do, searches
nineteen job sources in parallel, and orders everything it finds by real skill overlap — with the
count shown next to every row. It drafts a tailored cover letter for the roles that clear the bar,
then hands you a keyboard-driven triage screen.

**You press submit.** Nothing auto-applies — there is no browser-automation library anywhere in the
dependency tree, so the tool is physically incapable of filling or submitting a form.

Runs entirely on your machine. One binary, one command, no account, no server.

---

## Quick start

```bash
jobscout init          # set up, verify, and repair — the only setup step
jobscout run           # discover → enrich → match → score → draft
jobscout review        # triage: approve or reject by keystroke
jobscout prepare       # finalise approved jobs into the outbox
jobscout apply         # opens each one, cover letter on your clipboard — you submit
jobscout status        # where everything stands, and what has gone quiet
```

Settings you change often have a command; everything else lives in `config.toml`:

```bash
jobscout config                      # show the provider chain, models, and spend
jobscout config --budget 5 --period weekly
jobscout boards --discover           # find company boards to poll
```

From source:

```bash
bun install
bun run src/index.ts init
bun run build          # → dist/jobscout, a standalone binary
```

---

## How it ranks

Everything hinges on one decision: **the ranker is arithmetic, not a model's opinion.**

Your résumé becomes a skill graph — each skill with a category, how long you have used it, and the
line from your résumé that proves it. Every posting is parsed into required and preferred skills
against the same vocabulary, so `Postgres`, `PostgreSQL` and `psql` count as one match rather than
three misses. Then the overlap is counted.

```
Affirm — Senior Software Engineer, Payments

  Required matched   9 / 11   ████████████████████░░░░  82%

  ✓ Go · PostgreSQL · payments · ledgers · distributed systems
  ✗ Kafka (required) · Terraform (required)
  + Java · card networks · PCI compliance   — not asked for
```

Because it is arithmetic, the ordering is **reproducible**, **explainable**, and **free** — so every
posting gets measured rather than sampled.

Two details worth knowing. Scores are smoothed by how much was asked, so a posting listing one
requirement you happen to match does not outrank one listing eleven where you match nine. And the AI
score sits *alongside* the count, never replacing it — it catches what counting cannot, such as a
sales role at a payments company whose required skills match a payments engineer almost perfectly.

---

## Commands

| | |
|---|---|
| `init` | Set up, verify, and repair. Idempotent — also the maintenance command. |
| `skills` | Show, edit, or re-extract your skill profile. `--gaps` for what you're missing. |
| `discover` | Fetch new postings from every enabled engine, in parallel. |
| `boards` | Find and manage the company boards the ATS engines poll. |
| `enrich` | Fetch full descriptions for truncated postings. |
| `match` | Rank postings by skill overlap. |
| `score` | AI second opinion on what skill counts can't see. |
| `draft` | Cover letter, screening answers, and a list of gaps. |
| `review` | Full-screen triage. |
| `prepare` | Finalise approved jobs into the outbox. |
| `apply` | Open each job and stage its materials. You submit. |
| `status` | Pipeline, application lifecycle, staleness, engine health, AI spend. |
| `config` | Show or change the provider chain, per-task models, and spend limit. |
| `run` | discover → enrich → match → score → draft, in one go. |

---

## Where jobs come from

**No single engine is the source of truth.** Nineteen engines across five families, all behind one
interface, all running in parallel. Fifteen need no key at all.

| Family | Engines |
|---|---|
| **Applicant tracking systems** | Greenhouse · Lever · Ashby · Recruitee · Workable · SmartRecruiters |
| **Job boards** | RemoteOK · Arbeitnow · The Muse · Remotive · Himalayas · Jobicy · Hacker News |
| **India** | Foundit · Instahyre |
| **Aggregators** *(free keys)* | Adzuna · Careerjet · Jooble |
| **Scraper** *(opt-in)* | JobSpy → Indeed, LinkedIn |

They have complementary failure modes, which is the argument for running all of them. ATS boards
have the best data — full descriptions, direct apply links — but need to know which company uses
which platform. `jobscout boards --discover` closes that by probing company names against each
platform; no model involved, and it found Vercel, Celonis, Graphcore and Meesho unprompted.

Aggregators find anything but return a headline and a redirect, so `enrich` relays between the two:
an aggregator discovers the role, an ATS engine fetches the real posting.

Every engine records the outcome of every run — `ok`, `empty`, `error`, `rate_limited`, `skipped` —
so a broken source is never mistaken for an empty one.

---

## AI backends

Seven backends behind one interface, tried in order. The default chain costs nothing:

```
claude-code → codex-cli → gemini-cli → ollama
```

Agent CLIs come first because each spends a subscription you already hold rather than charging per
call; Ollama is free and local. **No paid provider is ever in the default** — there is a test
asserting it.

If none is available, `init` shows what it found and offers to set one up:

```
○ Claude Code       not installed           free
○ Ollama (local)    not running             free
○ OpenAI API        no key                  paid

◆  No AI backend is available. What would you like to do?
│  ● Install Claude Code    best quality · free with a Claude Pro or Max plan
│  ○ Install Ollama         free · local · no account, no key
│  ○ Use an API key         paid per token · set a spend limit
│  ○ Continue without AI    matching still works; drafting does not
```

Installs are never run for you — the command is printed and you run it. A scripted run
(`--yes`, or piped output) never blocks on the menu; it continues without AI.

### Cost control

Models are chosen **by task**, which saves money on every run rather than only once a limit is hit:

```bash
jobscout config --tier extract=ollama:llama3.1:8b   # ~120 calls/run, free and local
jobscout config --tier write=anthropic:claude-opus-5 # a handful of calls, quality matters
jobscout config --budget 5 --period weekly
```

The limit is checked **before a stage starts**, sized by the whole stage — so a run either completes
a stage or never begins it, and nothing is left half-written:

```
! Stopped before this stage — the spend limit would be exceeded.
  This stage is estimated at $0.21, but only $0.20 of your $5.00 weekly limit is left.
  Nothing was left half-finished.
```

Every figure is an **estimate** and is labelled as one. Costs record their provenance — `reported`
by the provider, `derived` from a price table, or `free` — and a model with no known price is
counted as unpriced rather than silently valued at zero.

### Without AI it still works

No-AI mode is a supported configuration, not a failure state:

- **Unchanged** — discovery, **matching**, ranking, review, tracking
- **Degraded** — normalisation, dedup, and skill extraction fall back to rules and keywords
- **Lost** — cover letter drafting

The AI never decides your ranking. It does the fuzzy work — reading prose into structure, and
structure back into prose — around an arithmetic core.

---

## Privacy

jobscout never asks for access to your email, calendar, or any account you own. An IMAP alert-inbox
engine was designed and deliberately dropped: mailbox access would have been the heaviest permission
in the tool, and app passwords are typically unscoped. The cost is that **Naukri is unreachable** —
its search API is behind a CAPTCHA — and jobscout says so rather than pretending otherwise.

The only credentials it ever stores are optional free API keys for three aggregators, kept in
`secrets.toml` at mode 600.

---

## Data layout

Everything lives in one portable folder you can copy, back up, or delete.

```
~/jobscout/
├── jobscout.db              all state
├── config.toml              preferences — safe to share
├── secrets.toml             credentials — mode 600, never shared
├── profile/
│   ├── resume.extracted.md  generated text the AI reads
│   ├── skills.toml          your skill graph — editable, edits survive re-extraction
│   ├── work-history.md      bullets beyond what fits on the résumé
│   └── cover-letter-style.md
├── drafts/{job_id}/
└── outbox/{job_id}/
```

---

## Development

```bash
bun test           # 429 tests
bunx tsc --noEmit  # typecheck
bun run build      # compile to dist/jobscout
```

Tests use `JOBSCOUT_HOME` and temp directories, so they never touch a real installation.

```
src/
  cli/       one file per command — arg parsing only, no logic
  setup/     everything `jobscout init` does; checks/ owns detect + fix
  engines/   19 sources, one file each, behind one interface
  skills/    canonical vocabulary, aliases, extraction, the matcher
  signals/   salary parsing
  profile/   résumé extraction (PDF / DOCX / text)
  ai/        router, budget, pricing; providers/ one file per backend,
             prompts/ versioned as files
  pipeline/  enrichment relay, prepare
  tui/       Ink review screen; all logic in a pure reducer
  db/        migrations (embedded at build time), typed queries
  config/    zod schema, load, secrets at mode 600, paths
  output/    colour, symbols, alignment
```

Five rules hold this together:

- **`cli/` holds no logic** — each file parses arguments and calls a service.
- **Every engine is one file** behind one interface, and passes the same contract suite.
- **The matcher is pure functions** — no I/O, no clock — which is what makes ranking reproducible.
- **The TUI's logic is a pure reducer**, testable without rendering anything.
- **Prompts are versioned files, not inline strings**, so a change to how jobs get scored shows up
  in a diff.
- **Every AI backend is one file** behind one interface, so the router never knows which is
  answering — and neither do the pipeline stages.

See [PROJECT.md](PROJECT.md) for the full specification and the reasoning behind each decision.

---

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Varun N.
