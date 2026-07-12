# Design handoff prompt — paste this to Claude

---

I'm building **Librarian** — a local-first decision library for AI agent sessions. I need you to design it for **two surfaces sharing one design system**: a **web app** (desktop reading, served by a local daemon) and a **native iOS app** (SwiftUI, for access from anywhere). Deliverables are staged at the end — show me the direction before building everything. Read the full context first.

## What Librarian is

Developers now run 5–6 parallel AI coding agent sessions (Claude Code, Codex, etc.). Each session produces multiple decision documents — plans, ADRs, PRDs, architecture docs — that today are buried inside linear chat transcripts. One chat cannot display many decisions; human attention is the bottleneck.

Librarian saves **every** decision into one local store on the developer's Mac (agents push via MCP; a watcher also auto-captures approved plans from session transcripts). The apps are the **reading and verdict surface**: a structured library — "an artifacts gallery, but for decisions" — so you never dig through chat history again, and you can green-light or red-light a pending design from anywhere.

Core beliefs the design must express:

1. **The PR-review model applied to agent decisions** — read the doc, then give the verdict. Reading is the center of the experience.
2. **Red lights are decisions too** — a rejection is recorded with the same weight as an approval, with its reason. The green/red verdict duality is the soul of the brand.
3. A review pass fits a **5–10 minute attention budget** — summaries for triage, full docs for verdicts, diffs for re-reads.
4. Daily-driver tool, not a marketing page. Information design over decoration.

## Information architecture (both surfaces)

Hierarchy: **Project → Session → Decision**. One session can hold many decisions.

Decision states: `pending` (amber) · `approved` (green) · `rejected` (red) · plus lineage: a rejected v1 can be revised into an approved v2 (`revised-into` / `superseded` chains).

Each decision record holds: title · kind (plan / ADR / PRD / architecture) · project · session · submitting agent · timestamps · version history · full markdown doc per version · comment thread (human + agent comments, some anchored to quoted passages) · verdict + reason · pinned context (commit hash, verified code snippets) · reviewer badges (LGTM / suggestions / blocker, from role-scoped reviewer agents like the "Librarian" consistency checker).

## Screens (same three on both surfaces, adapted per platform)

1. **Library home** — the centerpiece. Cross-project view of all decisions: status-marked cards/rows, filter by project / status / kind, full-text search, pending surfaced first. Must triage at a glance (badge row, one-line summary) and stay scannable at hundreds of decisions across 14 projects. Web may afford a denser multi-column/timeline layout; iOS is a triage list.
2. **Decision page** — the reading experience. Rendered markdown (long docs: headers, code blocks, tables), version switcher with v1→v2 diff, metadata (project, session, agent, dates, pinned commit), comment thread displayed as the decision's rationale, and a clear verdict banner — or, if pending, verdict actions: **Approve** / **Reject with reason** (text field) / **Comment**. Typography for sustained reading (~65ch measure on web; New York serif consideration on iOS).
3. **Session view** — all decisions from one session in order, showing how a working session accumulated decisions.

Design so a "Needs you" pending-verdict queue can later become the landing section on both surfaces without restructuring.

## Shared design system

- One brand, two idioms: identical palette semantics, spacing logic, and status language; each surface follows its platform's conventions rather than pixel-matching the other.
- Semantic colors (green/red/amber states) are separate from any accent tint, in both light **and** dark mode — all four combinations first-class.
- Status legible at a glance: encode state in **form as well as color** (icon + shape — e.g. checkmark seal / x seal / hourglass) — never color alone.
- The rejected state is shown **proudly, not as an error** — a red light is a first-class decision.
- Brand: a quiet library/archival sensibility (catalog cards, spine labels, stamps) kept subtle — serious daily tool, not a theme park. Avoid the generic AI-product look (cream + terracotta serif, dark + acid green, purple gradient heroes, Inter-everything).
- Tabular/monospaced digits for dates and counts; monospace for code, commits, tool names.

## Web app constraints

- Served locally by a Node daemon; **no external CDNs, fonts, or network assets** — system font stacks or embedded fonts only.
- Token-driven themes: `prefers-color-scheme` + `data-theme` override.
- Responsive down to 390px (it's also the fallback phone surface), but desktop reading is its home turf.
- Markdown with syntax-highlighted code; unified diff view; keyboard-friendly; visible focus states; `prefers-reduced-motion` respected.
- Deliver as self-contained HTML/CSS mockups (inline everything).

## iOS app constraints

**Top two priorities on mobile — design these before anything else:**

1. **Easy navigation.** Fewest taps to what needs me: bottom tab bar
   (Library · Needs You · Search) over buried hierarchy; push notification
   deep-links straight into the pending decision; an email-triage flow —
   after a verdict, advance to the next pending item (inbox-zero rhythm);
   swipe-back everywhere; 44pt+ targets; everything important
   thumb-reachable (verdict actions pinned in a bottom bar, never top
   corners).
2. **Easy feedback.** Verdict in ≤2 taps from notification. Comment
   composer one tap away at all times; select any doc passage → "Comment on
   this" (quote-anchored); reject-reason sheet with recent/suggested
   reasons as tappable chips; large dictation-friendly text fields;
   quick-probe chips ("What are the alternatives?", "What's the failure
   mode?") to interrogate without typing. Swipe actions on list rows for
   fast triage — but guard the doc-first thesis: swipe-approve is only
   offered on rows whose reviewer badges are all-green; anything flagged
   or unreviewed must be opened to reach its verdict actions.

- **SwiftUI, iOS 17+**, iPhone-first; structure views so iPad/macOS multiplatform is feasible later.
- Data from the daemon's **JSON API over Tailscale** — design the network reality: loading, empty, and unreachable ("Mac asleep?") states, pull-to-refresh; offline read cache nice-to-have.
- Dynamic Type (text-heavy screens must survive accessibility sizes); SF Symbols for status; SF Pro for UI, consider **New York** for doc reading; haptics (success on approve, warning on reject); safe areas; Reduce Motion.
- Markdown rendering: suggest a library (e.g. MarkdownUI) or AttributedString where sufficient.
- `NavigationStack`; verdict actions native (confirmation, reject-reason sheet).

## Deliverables (staged — pause for my feedback after stage 1)

1. **Direction**: design tokens (palette both modes, type scale, spacing — as CSS custom properties AND a Swift `DesignSystem` file) + the web Library home mockup. *Stop here and show me.*
2. **Web screens**: three self-contained HTML/CSS mockups (library home, decision page with pending verdict, session view), realistic content, both themes.
3. **iOS screens**: the same three as working SwiftUI views with `#Preview`s, sample data baked in, both color schemes; plus `Decision` / `Session` / `Comment` / `Verdict` Codable models with mock data so previews run without the daemon.
4. **Component inventory** (both idioms): decision card/row, status chip, badge row, version tabs, diff block, comment thread (incl. an anchored comment quoting a passage), verdict banner + action bar, search/filter bar, metadata rail/list.

## Realistic sample content (use this, not lorem)

- accounting_app · ADR · **approved** · "Pre-production security gate" — 2 versions, approved after 3 comments
- accounting_app · plan · **rejected** · "Split backend into microservices" — reason: "overkill for a single-user app; revisit at >10k users"
- lc_decision_tree · plan · **pending** · "Migrate chart rendering to Recharts" — blocker badge from Librarian reviewer: "conflicts with ADR-004 chart-simplicity-constraints"
- accounting_app · PRD · **approved** · "iOS agentic dashboard" — no comments (approved with zero questions = the clean one-tap case)
- swipe_app · architecture · **pending** · "Offline-first sync engine" — v2 after revision, diff available
