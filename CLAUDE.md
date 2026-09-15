# FOUNDER OS

Personal OS / AI agent command center. Live web recreation of the FounderOS
"Conducting AI" board. Runs on port **4100** (command-center owns 4000).

## Commands

```bash
npm run dev        # dev server → http://localhost:4100
npm test           # vitest suite (must stay green)
npm run typecheck  # tsc --noEmit
npm run seed       # re-seed data/founder-os.db (idempotent)
npm run build && npm start
```

## Stack

Next.js 14 App Router (server components) + TypeScript + Tailwind +
better-sqlite3 (`data/founder-os.db`, WAL, auto-seeded on first touch) +
Zod + Vitest.

## Architecture: larp-first, real-ready

This is the load-bearing design rule. v1 looks alive because of rich seeded
data, but every page and API route reads through the repository layer — never
query SQLite directly from a page or route:

- `lib/data.ts` — `getDb()` app singleton; seeds on first touch
- `lib/db.ts` — `openDb()` + repos (`departments`, `agents`, `metrics`, `tools`, …)
- `lib/seed.ts` — all seeded content lives here
- `lib/schemas.ts` — Zod schemas validate every row on the way OUT of the DB

Swapping seeded tables for live sources (Attio, Zernio, OpenClaw, MCP status)
is a repo-level change. Keep it that way: new data = new repo method + Zod
schema + seed entry + test.

## G-Brain — ANSWERED (2026-06-11)

G-Brain = **GBrain v0.41** (`gbrain` CLI on PATH): markdown
knowledge in `~/knowledge/brain-store/` + Supabase backend ("Second Brain",
free tier — pauses on idle) + ZeroEntropy embeddings (key in
`~/.config/knowledge/config.json`). The real provider in `lib/connectors/gbrain.ts`
shells out to the CLI (`doctor --json --fast`, `query --no-expand`) and falls
back to local brain-store grep when the database is unreachable. Default
`BRAIN_PROVIDER=gbrain`; `stub` exists for tests.

## Real connectors & agents (v2)

Alex's directive: real integrations, not larp. Strict black & white theme
(UI polish deferred — he'll design it himself once everything is wired).

- `lib/connectors/` — 12 connector groups, all returning honest
  `ConnectorStatus` (never fake "connected"): `email.ts` (4 IMAP slots),
  `slack.ts`, `payments.ts` (Stripe + registry), `notion.ts`, `gbrain.ts`,
  `zernio.ts` (key from ~/.config/social/.env — LIVE), `attio.ts` (key reused
  from ~/.config/mcp.json mcpServers — LIVE), `arcads.ts` (local `.env` —
  LIVE), `miro.ts` (knowledge/.env.agents — LIVE),
  `wispr.ts` (local flow.sqlite readonly — LIVE), `obsidian.ts` (vault fs;
  needs macOS Documents permission), `local-stack.ts` (local service ports
  + tmux + brew binaries).
- `lib/creds.ts` — credential resolution: process.env first, then Alex's
  canonical files at runtime. NEVER copy secret values into this repo.
- `lib/agents/runtime.ts` + `real.ts` — agent registry; every seeded agent row
  maps 1:1 to a `RuntimeAgent` with a real `run()` (enforced by seed tests).
  Runs persist to `agent_runs`. `POST /api/agents/[id]/run`.
- `/integrations` is the live Connections board (`GET /api/connections`).
- Credentials go in `.env.local` (gitignored) — see `.env.example`. NEVER
  commit keys; never copy keys from `~/knowledge/.env.agents` into the repo.

## Views

`/` operator console (pulse row, connections strip, agent list, compact
G-Brain core) · `/comms` unified feed · `/social` Zernio growth dashboard ·
`/agents` roster with Run buttons + last-run state · `/org` hierarchy board
(operator → Conductor super agent → 5 pillars: Sales, Marketing/Growth, TECH,
Finances, Communications → worker pills; broadcast composer; markup frozen —
do not restructure) · `/brain` G-Brain knowledge core (signature `BrainViz`
rings + live `gbrain ›` query card + doctor warnings, with the original
capture / life-map / pipeline / graph / query-path sections kept underneath) ·
`/roadmap` phases + quarters · `/analytics` real connector numbers ·
`/funnel` living client-journey flow (Vantage + Launchpad Cohort: stage
columns left→right, one node per client, 4–5 touch markers per path; seeded
dummy, real-ready for Trakyo organic + Meta Ads MCP paid attribution) ·
`/reference` reference model · `/integrations` live connections board. Chrome:
fixed `Sidebar` (Operate/System groups) + sticky `Topbar` (breadcrumb + ⌘K) +
`CommandPalette` (⌘K, digit-key view jumps). API routes mirror these under
`app/api/*` — note `GET /api/brain?q=` runs a hybrid search; bare `GET` returns
provider status.

## Conventions

- TDD: failing test first, then implementation. Tests live in `tests/`,
  one file per module; use `FOUNDER_OS_DB=:memory:` pattern (see `tests/db.test.ts`).
- Zod-validate anything that crosses the DB or API boundary.
- THEME: **Monolith Signal (`mono`) is the default** (2026-07-12,
  `DEFAULT_THEME` in `lib/theme.ts`; bare `:root` in `app/globals.css` carries
  the mono tokens). "Terminal" (`dark`) — the phosphor-green command deck on
  near-black — stays as a pickable colorway. Tokens live in
  `tailwind.config.ts` (`os.*` colors) AND as raw CSS vars in
  `app/globals.css` (the brain viz SVG + `color-mix` effects need `var()`
  access; keep the two in sync). Terminal tokens: `bg #050807`, `surface
  #0a0f0c`, `border #18211b` / `border-strong #243029`, `text #e4efe6` /
  `muted #8fa295` / `dim #54665b`, `accent #3df08c` (phosphor green), honest
  status colors `ok`/`warn #ffc53d`/`err #ff6259`. G-Brain viz uses its own
  independent violet/cyan/green palette (`--brain-1/2/3`). Lettering (Monolith pass,
  2026-07-10): JetBrains Mono everywhere — `font-sans` and `font-mono` both
  resolve to `--font-mono`; Space Grotesk is retired. Page titles 25px/700
  uppercase tracking 0.06em (`PageHeader`), eyebrows 9.5px/0.32em with a `//`
  prefix, section labels 10px/700/0.26em. Square corners (radius tokens are
  0), square LED status dots (blink, no pulse ring), no emblem hover-spin,
  hairline borders, no shadows on cards, 48px grid texture on the canvas
  (mono theme flattens it). The `mono` theme is **Monolith Signal**: bare
  black `#0a0a0a`, white accent, `--hairline #1c1c1c`, and color means
  status only (`ok #2fd36f`/`warn #ffb000`/`err #ff2d3f`). Shared primitives in `components/terminal.tsx`
  (`Dot`, `Badge`, `Label`, `SectionHead`, `Kbd`, `Spark`). `/org` keeps its
  existing markup — it inherits the tokens through Tailwind classes only.
- Env vars: `FOUNDER_OS_DB`, `BRAIN_PROVIDER`, `GBRAIN_BIN`, `GBRAIN_STORE`,
  plus connector creds in `.env.local`.
- Heavy interaction-driven visualizations load via `next/dynamic`
  (`ssr: false`) behind dimension-matched skeletons (see
  `BrainGraphView`/`AudienceConsistencyLazy`; contract in
  `tests/code-splitting.test.ts`). Use `next/image` for any future raster
  images — every current visual is SVG/canvas, so nothing needed a retrofit.
- Future: migrate hosting to a dedicated host; Supabase stays managed.

## Multi-agent etiquette

Multiple Claude Code sessions work on this repo concurrently:

- Commit small checkpoints often (`git log --oneline` to see where others are).
- Run `npm test && npm run typecheck` before claiming anything done.
- Don't kill the dev server on 4100 — another session may be using it.
- Leave handoff notes in `docs/` if you stop mid-feature.

---

## Project context (moved from global CONTEXT.md, 2026-08-14)

**Path:** `~/Documents/Projects/JARVIS-OS` — Jared's personal dev/ops cockpit. Separate from OLYMPUS by design. **Linear:** LCI, project JARVIS.
Fork of `Bennettxai/FounderOS-DEMO` (MIT cohort demo). **Repo is PUBLIC — make private before wiring any real credential.**

- **Single-operator by design** — no auth/RBAC, `better-sqlite3` local file DB. OLYMPUS adds Postgres/auth on its own side. Next.js 14 + TS + Tailwind + Zod + Vitest, dev port **4100**, **Node 22 pinned**.
- "larp-first, real-ready": every page/route reads through `lib/db.ts`, never raw SQL. New data = repo method + Zod schema + seed entry + test.
- Theme is **Monolith** (JetBrains Mono, `#0a0a0a`, color = status only). OLYMPUS `TASTE.md` does NOT apply here.
- **No `LICENSE`** (README claims MIT; commit `f10c948` deleted it). `lib/creds.ts` resolves the ORIGINAL author's local paths — rework before use.
- Ships a **Stripe** connector (`lib/connectors/payments.ts`). Do not wire it — Authorize.net/Shopify only.
- `scripts/reap-claude-orphans.sh` kills orphaned `claude` procs (ppid 1, no tty, >2h) — the SG-817 leak fix. **It never touches the DB — see LCI-7.**

In-flight LCI tickets for this repo live in `~/.claude/CONTEXT.md` § "JARVIS-OS / LCI" — that file is the dashboard, this one is the architecture.

---

## Repo context — moved from the global `CONTEXT.md` (LCI-191)

> Moved here 2026-09-15. This is single-repo content that had been loading in every
> session in **every** repo via the global `@CONTEXT.md` import, which had reached
> 92,898 chars — 3.7x its own written guardrail. It now loads only here.
>
> **Verbatim.** Nothing was cut in the move; compression is a separate step.
>
> The in-flight ticket table below is **pending `/status`** (live from Linear) and gets
> deleted from this file when that lands. Until then it can go stale — Linear is the
> source of truth, this table is a convenience copy.

**Path:** `~/Documents/Projects/JARVIS-OS` · **Linear:** LCI, project JARVIS · dev port **4100**
Jared's personal dev/ops cockpit. Separate from OLYMPUS by design. Fork of `Bennettxai/FounderOS-DEMO`.

- **Repo is PUBLIC — make private before wiring any real credential.**
- Ships a **Stripe** connector (`lib/connectors/payments.ts`). Do not wire it — Authorize.net/Shopify only.
- **Node 22 pinned** (`.nvmrc` + `engines`) — `better-sqlite3` has no prebuild for 25/26. fnm switches on `cd`; default `node` is 26, so run npm via `zsh -i -c`.
- `scripts/reap-claude-orphans.sh` kills orphaned `claude` procs (ppid 1, no tty, >2h) — the SG-817 leak fix. **Never touches the DB — see LCI-7.** Runs from `~/.local/bin` (launchd can't exec under `~/Documents` — TCC), label `com.jaredharvill.claude-reaper`, /30min.
- `scripts/codex-review.sh` (LCI-6) — `codex exec --sandbox read-only`, `--spec`/`--deferred`, no verdict → exit 2 never a pass. Codex quota confirmed WORKING 2026-08-21 (the 08-14 exhaustion note was stale).
- CI job name `Build & Test` is load-bearing (org ruleset matches it); Node from `.nvmrc`, asserts v22 + prebuild.
- **Headless dispatch costs 45–70k tokens before any work.** Opus $0.65 / Sonnet $0.43 / Haiku $0.09, same prompt — pin a model per lane (LCI-11).
- Stack, theme, architecture rule: **`JARVIS-OS/CLAUDE.md`**. Session narrative + machine facts: **LCI-16**.

### What's shipped (JARVIS-OS)

- LCI-13 — `Build & Test` CI, first in the repo (#2) · LCI-6 — Codex cross-family reviewer, on `main`

### In-flight (LCI / JARVIS)

**LCI-109 defect 1 is FIXED — step 4 is UNBLOCKED in every repo** (verified 2026-09-04 by running LCI-29 through it end to end). LCI-103 made `build_test_prompt` return a `TestPrompt` carrying `.segments`, so the scan reads interpolated content only and can no longer flag its own boilerplate; the ticket's own repro is stale, calling `.replace()` on what is no longer a `str`. **But the fix overshot into fail-open: `allowed_texts` is constructed identically to `segments`, so residue reduces to whitespace and `assert_no_implementation` can never fire** — measured 31,860 → 0 non-whitespace on real inputs. Blindness now holds by CONSTRUCTION (allowlisted prompt), not by verification; never cite a clean lane pass as evidence. Defect 2 (walks gitignored paths) still live, harmless only while residue is empty.

Full table lives in Linear (team LCI, projects JARVIS / jarvis-context / **ATLAS**). **LCI-16 is the JARVIS resume point; LCI-47 is the ATLAS one.**
Blocking chain: LCI-12 (auth gate) + LCI-7 (stale claim TTL) + LCI-8 (decisionType) gate the spawner.
LCI-14 PUSHED on `lci-14-model-routing` in spiritguide-ios + spiritguide-android (2026-08-24); identical 612-line add — `routing.yaml`, `scripts/routing_loader.py`, `AGENTS.md`, `CLAUDE.md`. **No PRs opened yet** — that is what still gates LCI-9.


**Next actions:** SG-1388 → SG-1389/1390 → SG-1391 → LCI-15, then LCI-7/LCI-8 → spawner. **LCI-14's `get_reviewer_model()` hard-raises on shared MODEL_FAMILY; evidence does not support that as an invariant** — relative capability decides, not family. Make it default-with-override. Evidence: `Solrise/JARVIS/2026-08-16_autonomous-sdlc-research-and-build-order.md`.

**Fleet-size ceiling (measured):** 3–5 agents/repo; break-main 0.77% at 2–5 writers vs 12.5% at 40+. Verification throughput is the lever (LCI-10).

---
