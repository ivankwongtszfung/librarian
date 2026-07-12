# PRD — Librarian

*An agent-independent decision review layer, exposed as an MCP server. Any AI
agent submits its plans/ADRs/design docs for human review; the human reads,
comments, and green/red-lights from any device; every verdict builds a
searchable decision library that agents themselves can query.*

Status: Draft v2 (agent-agnostic architecture) · 2026-07-11 · Ivan + Claude

---

## Problem

A developer runs 5–6 concurrent AI agent sessions across multiple projects
(measured: 5 sessions / 4 projects active within one hour on 2026-07-11).
Human attention is the bottleneck:

- Decision docs are scattered across repos and session transcripts; no single
  place to read them.
- Sessions block on approvals while the user is elsewhere (other terminal,
  phone, away).
- Approvals get rubber-stamped because the doc and the prompt live in
  different places.
- **Rejections vanish.** A red light shapes the design as much as a green
  light, but no record survives. Agents don't share memory, so rejected ideas
  get re-proposed and re-reviewed endlessly.
- Tooling must not be married to one agent. The agent landscape shifts;
  the review layer should outlive any single CLI. → **MCP server**, the one
  protocol every major agent speaks.

## Core thesis

**The PR-review model, applied to agent decisions.** You don't merge a PR
from the notification email — you read the diff, then approve. The decision
doc and the verdict button are the same screen; reading is the path of least
resistance.

1. A review pass fits a 5–10 minute attention budget: summaries for triage,
   full docs for verdicts, diffs for re-reads.
2. **Red lights are decisions too** — recorded with the same weight as
   approvals, and queryable by future agents.
3. The archive is *exhaust* of the review flow, not a documentation chore.
4. **Agent-independent by construction**: the core speaks MCP only.
   Agent-specific integrations are optional adapters, never the foundation.

## Positioning

Same interaction primitive as Claude Tag (Claude in Slack): a multiplayer
commenting session over a design doc, with agents as participants. The
difference is the **atom** — chat's is the ephemeral message; ours is the
versioned document with anchors, lifecycle state, and memory. Constituency:
the solo operator running many agents against local codebases (for a team
that lives in Slack, Tag largely *is* this product). Durable
differentiators, deliberately misaligned with any single vendor's
incentives:

1. **PR-review semantics** — doc-first gating, anchored comments, revision
   diffs (chat surfaces can't read long docs well).
2. **A memory of verdicts** — the red-light/green-light library, queryable
   by agents; threads scroll away, decisions shouldn't.
3. **The trust layer** — claims verified against the local repo before
   review; no SaaS surface can grep your laptop.
4. **Agent-agnostic MCP core** — fronts every vendor's agents.

Strategy: don't compete with chat UIs — **build on one**. Chat (Discord/
Slack) is the v1 interaction surface; the product's own value lives below
it (the store, the gate, the memory, the trust layer) and beside it (the
doc renderer). Tag validates the surface choice; the layers under it are
what Tag doesn't have.

## Architecture: protocol core + optional adapters

### Core data model — the commenting session, generalized

The primitive shared with Slack/Tag, Google Docs, and PR review: **a
commenting session over a design artifact, with the agent as a
participant**. The difference is the atom: chat's atom is the ephemeral
message; ours is the **document**. Schema:

- **Document** — versioned (v1 → v2 lineage), one per submitted design
- **Participant** — human *or* agent, first-class from day one (multiplayer
  review — a teammate, a second specialist agent — is a toggle, not a
  rewrite)
- **Comment** — authored by any participant, optionally anchored to a
  passage of a specific version
- **Verdict** — a state transition (pending → revised → approved/rejected),
  not a message

Every surface — web console, Slack doorbell, GitHub PR — is a *view* over
this one store, never the store itself.

### Core — the MCP decision gateway (agent-independent)

One server (streamable HTTP on localhost; many concurrent agent clients),
one SQLite store (FTS5). **Surfaces are rented, not built (v1)**: a chat
platform supplies interaction — mobile, push, threads, buttons, unread
state, multiplayer — while a one-route **read-only doc renderer** (markdown
→ HTML + version diff, behind Tailscale) supplies the reading experience
chat can't. Discord preferred for solo (free, forum channels = one post per
decision with pending/approved/rejected tags → free triage board, better
markdown); Slack if it meets a workplace. Flow: submit → bot posts
title/TL;DR/verdict buttons + "read full doc" link; comments = thread
replies (quote-a-passage replaces click-anchoring); `/peek file:lines` in
thread = live snippet drill-down; agent revisions land in the same thread.
SQLite remains the archive — chat retention limits don't matter. Custom
full console: v2, only if chat friction proves real; the store is
surface-agnostic so nothing is rewritten.

**MCP tools exposed to agents:**

| Tool | Purpose |
|---|---|
| `submit_for_review(project, title, doc, kind, parent_review_id?)` | Submit a plan/ADR/PRD for human verdict. Returns `review_id`. |
| `get_review(review_id)` | Poll until resolved → `{verdict, comments[], reason}`. Polling chosen over one long-blocking call: robust across client timeout behaviors. |
| `record_decision(...)` | Non-blocking archive entry (FYI tier, no gate). |
| `search_decisions(query, project?, filters?)` | Mid-design lookup: ranked full-text search over past decisions **including rejections**; filters by status/kind/date. |
| `get_constraints(project, topic?)` | Pre-design briefing: bounded, queryless digest of accepted + rejected decisions with reasons — covers the constraints an agent wouldn't know to search for. |

- **Feed-forward is native**: agents call `search_decisions` /
  `get_constraints` *before* designing — the red-light memory prevents
  re-proposing rejected ideas without any context-injection hacks.
- **Comments are structured tool results**: the human's anchored comments
  return to the agent as data. Agent reacts, revises, resubmits with
  `parent_review_id` → version lineage and diffs for free. No scraping.
- **Adoption** = one line in each agent's instruction file (CLAUDE.md /
  AGENTS.md / rules): "Before finalizing any design or plan, submit it via
  the decision-gateway MCP tool and poll for the verdict." Cooperative by
  nature — see Adapters for what convention can't cover.

### Context enrichment (the trust layer)

The doc alone is self-reported context — it can be stale or hallucinated.
Enrichment must be independent of the submitting agent:

1. **Self-report (untrusted claims)**: `submit_for_review` takes optional
   `context_refs` (files / symbols / endpoints the design touches).
2. **Gateway-side verification at submission**: the gateway (running where
   the code lives) resolves every reference in the doc against the real
   codebase — pulls current snippets for cited files/functions and **flags
   phantom references** ("§3 cites `AuthService.refresh()` — not found").
   Hallucination detection at review time, before the green light.
   Backend: MCP client of codebase-memory-mcp where indexed
   (`search_graph`, `get_code_snippet`, `trace_path` for blast radius —
   "modifies `process_payment`, called from 12 sites"); ripgrep fallback.
3. **On-demand drill-down from the UI**: tap a file reference → live
   snippet; per-card code search box. Phone → Tailscale → gateway → local
   FS; only viewed snippets ever leave the laptop.

Enrichment is **pinned at verdict time** (commit hash + snippets as
reviewed) so archived decisions stay answerable against the code as it was.

### Reviewer panel — role-scoped agents comment the thread

Participants are human *or agent*; reviewer agents are role-scoped
participants that comment on a submitted doc **before the human arrives**
(PR model: CI + codeowners run first). The human's attention shifts from
finding issues to adjudicating flagged ones.

- **Roles**: security, simplicity/YAGNI, performance, cost — configurable
  per project (`reviewers.yaml`: role prompt, model, trigger). Spawned by
  the gateway as headless agent calls; in Discord each posts under its own
  webhook persona ("🔒 SecBot", "📚 Librarian").
- **The librarian (built-in, v1)**: sole job is `search_decisions` /
  `get_constraints` — flags conflicts with prior ADRs and re-proposals of
  red-lighted ideas on *every* doc. Feed-forward becomes enforced, not
  hoped-for.
- **Advisory only**: reviewers emit badges (🟢 LGTM / 💬 suggestions /
  ⚠ blocker) + comments; only the human transitions verdict state. Badge
  rows double as triage: all-green → candidate one-tap approve; ⚠ floats
  to top of Needs-you.
- **Pre-human round, capped**: the submitting agent may answer reviewer
  comments once, then waits for the human — no agent-to-agent spirals.
- **Noise & cost controls**: role prompts mandate "silence is acceptable,
  max N comments"; orthogonal roles; reviewers you consistently ignore get
  pruned; cheap models for routine lenses; resubmissions get **diff-only**
  re-review.

### Review UX (the human side)

- **Sections**: *Needs you* (pending reviews, oldest-blocked first) → *New
  decisions* (unread FYI feed, grouped by project) → *Library* (search).
- **Cards are briefing packets**: full doc rendered inline; verdict buttons
  at the bottom, PR-style. Related prior decisions from the same project —
  **including rejections** — surfaced beside the doc (keyword match v1).
  Verified code context (current snippets, blast radius, phantom-reference
  warnings) rendered alongside the doc's claims.
- **Review is a conversation.** Verbs: **Comment · Ask · Reject-with-reason ·
  Approve.**
  - *Inline comments + batch submit (the review pass)*: select a passage →
    anchor a free-text comment; comments accumulate; one *Submit review*
    returns them all as one structured tool result. Agent addresses
    interacting comments coherently in a single revision cycle.
  - *Comprehension questions* ("I don't understand") → side-channel model
    call with doc + repo context; the submitting session never knows.
  - *Challenge questions / rejection reasons* → returned via the review
    result; agent answers or revises and resubmits.
  - *Thread view*: doc v1 → anchored comments → agent response → doc v2
    **diff** → verdict. Resolution checkboxes per comment (v2).
- **The happy path stays one tap.** Often the doc is just right — read,
  approve, proceed. No forced friction on normal cards; friction is
  proportional to risk. An untouched approval still archives, and "approved
  with zero questions" doubles as a plan-clarity signal.
- **Remote**: Tailscale for network + identity; ntfy.sh push on new pending
  review; tap-through to the card.

### Remember (archive side)

- Every verdict auto-produces a decision record: doc + verdict (approved /
  rejected / revised-into / superseded) + comments thread + reason +
  timestamp + project + submitting agent/session.
- **The comment thread is the rationale section** — what was confusing, what
  was challenged, what survived. Anchored comments are *located* rationale.
- **Rejection lineage**: rejected v1 → reason → approved v2 chains into an
  auto-generated ADR with a real "alternatives considered" section.
- Promoted formal docs live repo-native (`docs/adr/`); the DB is index +
  candidate store, so the app stays disposable.

### Adapters — optional, per-agent (NOT the foundation)

MCP is cooperative: native permission prompts (e.g. Claude Code asking to
run a Bash command) never flow through it. Adapters add interception where
wanted:

- **Claude Code adapter (v1.5)**: transcript watcher (`~/.claude/projects`
  JSONL tail) for session state + FYI cards; `Notification` hook as pending-
  prompt trigger; tmux `capture-pane`/`send-keys` bridge for answering native
  prompts remotely. Sessions launch via a `ct` tmux wrapper.
- Other agents: adapters if/when needed; docs-review-only works everywhere.

## Security (non-negotiable)

- Server binds localhost only; remote access via Tailscale identity + app
  token. Every remote verdict logged.
- Full doc/command always rendered before any approve button.
- Adapter tier only: destructive native prompts (`rm`, force-push, deploys)
  are terminal-only, never remote-approvable. Friction is a feature on
  dangerous cards; the threat model is self-inflicted half-reading on a phone.

## MVP cut

**Re-prioritized 2026-07-11: the library IS the product.** One session
produces many decisions; a chat thread is linear and can't hold them — the
centerpiece is the structured, centralized view (an "artifacts gallery" for
decisions), not the chat surface. Build order:

1. **Phase 1 — Store + Library view + ingestion.** SQLite store behind a
   daemon JSON API; **two clients, one design system** (brief:
   `docs/design-brief.md`): a local **web app** (desktop reading; project →
   session → decision hierarchy; status-colored cards green/red/amber;
   rendered doc pages with versions; search/filter/timeline) and a
   **native iOS app** (SwiftUI, over Tailscale — triage list, doc reading,
   verdicts from anywhere). Ingestion is dual-path so nothing is missed:
   agents push via MCP (`record_decision` / `submit_for_review`) AND a
   Claude Code transcript watcher auto-captures ExitPlanMode plans +
   docs/ writes live (promoted from the adapter tier — capture side only).
2. **Phase 2 — The review gate.** Verdicts, comments, lineage, get_review
   long-poll, librarian reviewer, enrichment.
3. **Phase 3 — Chat surface.** Discord notify + quick verdicts, deep-link
   to the library page.

**In**: MCP server with the five tools; SQLite + FTS; **Discord (or Slack)
bot as the interaction surface** — post-per-doc with verdict buttons,
thread comments with quote-anchoring, forum tags as triage; read-only doc
renderer page (markdown + v1/v2 diff) behind Tailscale; version lineage;
decision records incl. rejections + threads; instruction-file snippet for
agents; enrichment v1 = reference verification via ripgrep + `/peek`
snippet drill-down in threads; **one built-in reviewer: the librarian**
(past-decision consistency on every submission — proves the panel
machinery with the highest-value lens, one voice = no noise).

**Out (later)**: configurable reviewer panel (`reviewers.yaml` roles beyond
the librarian), custom full web console (only if chat friction proves
real), Claude Code adapter (hook + tmux native-prompt bridge),
codebase-memory-mcp enrichment backend (graph blast-radius, symbol
resolution), side-channel comprehension Q&A, quick-probe chips, resolution
checkboxes, LLM catch-up digest, embeddings-based related-decision matching,
retro mining of the 750MB transcript backlog, cross-session conflict
juxtaposition, menu bar app.

## Prior art & leverage (surveyed 2026-07-11)

**The approval/remote-control half is crowded; the decision-memory half is
empty.** Build the library, rent or fork the gate.

- **HumanLayer** (Apache-2 OSS): `require_approval` decorators, omnichannel
  contact (Slack/email/Discord), deny-with-feedback returned to the LLM —
  validates our reject-with-reason → agent-reacts loop. Study their channel
  + state model.
- **Preloop** (OSS control plane): MCP firewall, CEL policy, HITL approvals
  with **async approval mode (tool returns, agent polls)** — independently
  converged on our long-poll design. Governance/tool-call framing, not
  doc-review framing; evaluate as approval transport before building ours.
- **Omnara** (YC S25, OSS + iOS/Android apps): mission control + one-tap
  native-prompt approval for Claude Code/Codex from phone. Could REPLACE
  the entire v1.5 tmux adapter — rent this, don't build it.
- **Claude Code Channels** (official): bridges Claude Code to Discord/
  Telegram/webhooks. Check first — may cover session→chat notify natively.
- **claude-code-discord-bridge (ebibibi)** / **discord-claude-code-bot
  (fredchu, ~1000-line TS)**: plan-mode Approve/Cancel and permission
  Allow/Deny as Discord buttons, thread-per-session. Fork/steal patterns
  for our Discord surface.
- **OpenACP**: agent-agnostic chat bridging via Agent Client Protocol —
  candidate adapter transport instead of per-agent scraping.
- **MCP elicitation** (spec, June 2025): protocol-level human input — but
  routes through the agent's own client UI; wrong screen for us, know it
  exists.
- **ADR ecosystem**: adopt **MADR/Nygard format** for exported ADRs;
  **log4brains** can render the library as a static site later;
  codebase-memory-mcp `manage_adr` as graph export target.
- Commodity parts: official MCP TS SDK, discord.js, SQLite FTS5.

**What nobody has** (= our focus): versioned decision docs with comment
threads as rationale; red-light memory queryable by agents
(`search_decisions` / `get_constraints`); context verification against the
local repo (phantom refs, pinned snippets); the librarian reviewer.

## Riskiest-first spike order

1. Convention reliability: does an agent, given the instruction-file line,
   consistently call `submit_for_review` at the right moments and poll
   `get_review` without wandering off? (Test with Claude Code + one other.)
2. Comment round-trip quality: anchored comments → structured result → does
   the agent revise coherently and resubmit with lineage?
3. Poll ergonomics: verify long waits don't burn tokens/context absurdly
   (poll interval guidance in the tool description).
4. Then the UI is just rendering.

## Open questions

- Name: resolved — **Librarian** (2026-07-12).
- Repo location: resolved — `~/Projects/librarian` (2026-07-12).
- iOS distribution: free-account sideload (7-day resign) vs $99/yr dev
  account (TestFlight, push entitlements). Decide before Phase 1 ships.
- Distribution model: resolved in principle (2026-07-12) — **local-first
  OSS with one-command setup** (`npx`/`brew`; iOS companion app connects to
  the user's own daemon, Home Assistant model). Pure SaaS rejected: kills
  the trust layer (local repo grep) and the data-ownership moat — the one
  positioning SaaS-backed competitors (Omnara/Preloop/HumanLayer) can't
  copy. Open-core option parked for later: a thin paid E2E relay for
  remote reach + native APNs push + team multiplayer, storing nothing
  (Obsidian Sync playbook). Revisit only if outside users materialize.
- Remote transport: **Tailscale must not be a hard dependency**
  (2026-07-12). Tiered design — Tier 0 localhost; Tier 1 LAN zero-config
  (Bonjour/mDNS discovery + QR pairing: local addr + bearer token + pinned
  self-signed cert), covering most real phone use; Tier 2 remote,
  pluggable: auto-detect Tailscale if present, else the E2E relay
  (outbound-only WSS, self-hostable, stateless — Plex/Home Assistant
  Cloud model). Personal v1 ships Tailscale-only (M6 unchanged); tiers
  are OSS-release scope. Constraint now: keep the API/auth layer
  transport-agnostic. Caveat no transport fixes: a sleeping Mac serves
  nothing — document `caffeinate`.
- Backend: Node/TS (official MCP SDK, chokidar later, easy SSE) vs Python
  (FastMCP) vs Go. Leaning Node/TS for SDK maturity.
- Is the Claude Code adapter v1.5 or bundled into v1? (Native-prompt remote
  approval was an original wish; core-first keeps the product honest.)
- How should `get_review` advise poll cadence to keep agent token burn low?
