# ADR-002: How a verdict reaches the agent

**Status:** proposed · **Date:** 2026-07-12 · **Project:** librarian

## Context

`submit_for_review` returns a `review_id` immediately; the agent learns the
verdict by long-polling `get_review` (`wait_seconds ≤ 50`). That is the whole
delivery story today, and it only covers the case where the agent is mid-turn
and willing to burn tool calls waiting. A review that outlasts the turn, the
session, or both has no delivery path at all — the verdict sits in
`verdict_events` until someone happens to ask.

The governing fact: **an agent is not a server.** A Claude Code session
executes only when its harness invokes it, and you can't push into a harness
you don't own. A verdict can therefore reach the submitting agent in exactly
three windows — mid-turn (it can block), in-session but idle (something must
wake it), and cross-session (the submitter is gone; only the store survives).

Two codebases were read to the line as prior art before deciding:

1. **OpenClaw** (MIT) — a standalone multi-channel agent gateway. Its exec
   approvals are a deferred-promise registry (`Map<id, {promise, resolve,
   reject, timer}>`, `src/gateway/exec-approval-manager.ts:309`) resolved by a
   Discord button whose `custom_id` carries the whole decision
   (`extensions/discord/src/approval-custom-id.ts:10`). Same shape as our
   EventBus + long-poll, but in-memory and fail-closed — right for
   seconds-scale exec approvals, wrong for hours-scale reviews.
2. **Anthropic's official Discord plugin** (`discord@claude-plugins-official`
   v0.0.4, Apache-2.0, one 900-line `server.ts`) — which reveals the sanctioned
   push-into-Claude-Code mechanism: an MCP server declaring the experimental
   `claude/channel` capability emits `notifications/claude/channel` and the
   harness turns them into agent turns (`server.ts:443, :875`). It also ships a
   remote Allow/Deny button flow for permission prompts
   (`claude/channel/permission`, `server.ts:476–518, :747–803`) and a security
   ledger worth copying defense-by-defense (injection-resistant framing,
   outbound gate mirroring inbound, state-exfiltration guard, idempotent
   terminal edits).

The full trace, with file:line receipts for both codebases, lives in the
"How the agent learns the verdict" design note (artifact, rev 2).

One invariant from CLAUDE.md constrains everything below and is restated here
because this ADR is its second application: **the `EventBus` only wakes
waiters early — delivery is the idempotent read of committed rows.** Any
delivery mechanism this ADR adds is a latency optimization over
`verdict_events`, never the record.

## Options considered

### A. Long-poll only (status quo)

Covers window 1 and nothing else. A two-hour review is ~140 tool calls and a
turn that never ends; a dead session means the verdict is never learned.
Correct as the mid-turn primitive, unacceptable as the whole answer.

### B. A Stop hook that blocks the session until the verdict

Works mechanically, hijacks the session to do it: the harness re-prompts and
burns turns polling. Everything B buys, C buys cheaper.

### C. Background waiter — `librarian wait <review_id>`

A CLI that re-loops the 50s long-poll (reconnect semantics already pinned by
`tests/features/longpoll.feature`) and exits printing the verdict JSON. The
agent runs it as a background task; the harness's task-notification on exit
*is* the push — the only push channel every harness exposes. Zero tokens while
waiting.

### D. Librarian channel — an MCP server declaring `claude/channel`

A ~100-line stdio server, subscribed to the daemon's SSE, that pushes a
verdict as the session's *next turn* — natively, no polling, no waiter
process. This is the cleanest window-2 delivery that exists. Caveat: the
capability is experimental and the only known consumer is a v0.0.4 plugin;
this option must never be the floor.

### E. Daemon-spawned headless resume

When nobody is listening, the daemon shells out `claude -p --resume
<session_id>` with the verdict as the next user message — the daemon acting as
harness owner for one continuation. This is the feature that makes an approve
tap from a phone *start the implementation*, and therefore also the option
whose cost must be named: an approve tap becomes remote code execution.
Guardrails are non-negotiable: config-gated and off by default, explicit
permission mode, at most one spawn per verdict, every spawn logged as an
event. Resume fires only for `approved` and `changes_requested`; `rejected`
means stop — the reason lands in `get_constraints`, which is the product.

### F. Pull-on-wake — hooks over committed rows

A `SessionStart` (or `UserPromptSubmit`) hook injects pending reviews and
unseen verdicts into the next session that wakes in the project. No routing,
no liveness, no protocol — just the idempotent read. This is the floor that
makes every option above safe to treat as optimization.

### G. The human direction — Discord as reviewer surface

Not agent delivery, but decided here because the trace decided it. Two stages:

- **Pilot (zero code):** a "review desk" session using the official plugin +
  librarian MCP — submissions posted via `reply`, verdicts typed as text. Its
  ceiling: the gatekeeper is an LLM interpreting prose. Fine to validate the
  workflow, wrong for the gate.
- **Bridge (~300–500 lines, discord.js, modeled on `server.ts`):** SSE
  consumer → forum post per decision (title, TL;DR, doc-renderer link, tags as
  triage) → buttons with `verdict:<review_id>:<action>` in `custom_id` → red
  lights open a modal that demands the reason (a fourth door for the
  reasons-required invariant, alongside state machine, SQL CHECK, and HTTP
  422) → `POST /api/decisions/:id/verdict` with the bearer token → terminal
  edit kills double-clicks. The Discord post is a view over the row, never the
  record.

## Decision

**Adopt the escalation chain — C, D, E, F layered in order behind the
committed row — plus G's two-stage Discord surface.**

On verdict, the daemon:

1. **Commits** to `verdict_events` (always first; this is delivery).
2. **Releases** any open long-poll for the review (window 1 and the `wait`
   CLI). Holding the long-polls means the daemon knows who is listening —
   which is also what prevents a live interactive session from being resumed
   headless behind its own back and forking the transcript.
3. **Pushes over the librarian channel** if the submitting session has one
   connected (window 2, first-class).
4. **Resumes headless** under E's guardrails if nobody was listening
   (window 3, opt-in).
5. **Rests** on rows + hooks (F) — the guarantee when everything above
   misses.

Build order: `librarian wait` CLI → hook installer → pilot review desk →
Discord bridge → librarian channel (flagged experimental) → resume adapter.

## Consequences

- Five components are owed: the `wait` subcommand, a hook installer
  (`librarian hook install`), the Discord bridge, the channel MCP server, and
  the resume adapter. Each is independently shippable; the chain degrades
  gracefully to F if any is absent.
- Delivery must be recorded append-only (attempts table), at-least-once, and
  crash-safe. Correctness never depends on a notification arriving — the BDD
  scenarios that already fail in-memory refactors of `get_review` now also
  guard steps 2–4.
- The resume adapter turns a phone tap into local code execution. It ships
  off by default, and its guardrails (permission mode, one spawn per verdict,
  spawn events in the log) are part of the definition of done, not hardening
  to add later.
- The channel path depends on an experimental capability; if it breaks in a
  harness update, the chain silently falls through to resume/rest — by
  design.
- New BDD scenarios owed: waiter-detection (no resume while a long-poll is
  open), resume guardrails, verdict-button idempotency, and modal-enforced
  reject reasons.
- The bridge inherits the official plugin's threat model, and its security
  ledger applies row by row: verdict authority only for the paired snowflake,
  access mutations never downstream of chat, meta-vs-content separation for
  anything sender-controlled, outbound gate mirroring inbound, and the bot
  never sending its own state.

## Alternatives rejected

- **MCP push notifications as general delivery** — rejected: no harness turns
  an unsolicited notification into a turn, *except* via the channel
  capability, which is exactly option D and is adopted as an optimization, not
  the floor.
- **Stop-hook blocking (B)** — rejected: C gets the same wake-up without
  hijacking the session or burning polling turns.
- **Adopting OpenClaw wholesale** — rejected: 36k lines in its Discord
  extension alone, hand-rolled gateway client, and a plugin framework priced
  for 100+ channels. We take its patterns (verdict-in-`custom_id`,
  authorize-the-clicker, terminal edits, per-session FIFO); we don't pay its
  generality tax.
- **Official-plugin-only for reviews (G's pilot as the end state)** —
  rejected: a typed "approve" is interpreted by a model before it becomes a
  verdict. The whole thesis of this product is that verdicts are crisp
  append-only records; the gate must be a deterministic button, not an
  inference.
