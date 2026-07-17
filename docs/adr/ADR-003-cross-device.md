# ADR-003: Cross-device review — the record, the mailbox, and the channel

**Status:** proposed · **Date:** 2026-07-17 · **Project:** librarian

## Goal

Make it so a human can review and decide on a decision from **any of their
devices**, and the agent acts on it — **without losing a verdict**, **without a
decision's content ever being readable off the user's machine**, and **without
the user having to run or trust a service**.

We know it works when this passes, end to end — the sleeping-machine test:

> An agent submits a decision from my laptop while I'm out. My phone shows it and
> buzzes. I read it and reject it with a reason. My laptop was asleep the entire
> time. When it wakes, the agent receives the rejection and revises — no verdict
> was lost, and nothing readable about the decision ever sat on a server.

Success is five properties, each independently testable:

1. **Reach** — I can act on a pending decision from a device that is not the dev
   machine.
2. **Losslessness** — no verdict or comment is ever lost across a dropped
   connection, a daemon restart, or a sleeping machine; the outcome is always
   reconstructable from committed local rows.
3. **Privacy & integrity** — the mailbox operator, and anyone in the middle, only
   ever sees ciphertext (cannot read a decision), *and* cannot forge a verdict:
   an inbox entry is applied only if it authenticates under the user's key, bound
   to a decision + version. (The forge half depends on ADR-004.)
4. **No service dependence for correctness** — the mailbox being slow or down
   costs latency, never a decision; the record lives only on the user's disk.
5. **Agent action** — approve makes the agent proceed, reject (reason required)
   makes it stop or revise, a comment gets addressed. The verdict is a *signal*
   to a session that already holds the context.

Responsiveness is a sixth quality — the phone should reflect a pending decision
promptly — but its target latency is a tuning number still open (see below), not
a pass/fail line for "does it work."

**In scope for this goal (Phase 1):** the human↔agent approve / reject / comment
loop across devices, over the local channel and the encrypted mailbox, for a
single user (per-user isolated). **Out (Phase 2):** the multi-role reviewer panel
and codebase-memory grounding.

**Done when:** the sleeping-machine scenario passes as an automated end-to-end
test, each of the five properties has a guarding test, and a second device can be
paired and revoked.

## Context

An agent on the user's machine submits a design and blocks on `get_review`
until a human decides. The human is often not *at* that machine — they are on a
phone, away from the desk. Today the daemon and everything it serves (MCP, REST,
SSE, the web UI) are bound to `localhost`, so review only happens at the desk.
This ADR decides how a verdict or comment crosses to another device and back to
the agent.

**The governing fact — and it retires an earlier framing.** Two endpoints that
are not guaranteed online at the same instant cannot hand off directly. The
daemon may be asleep when the phone opens the review; the phone may be offline
when the daemon publishes. There is no "pure connectivity" answer: spanning two
devices *across time* requires a durable drop-point between them. An earlier
draft of this design (a tunnel with no server-side storage) was wrong for
exactly this reason — a tunnel only works while both ends are up.

The hard constraints from ADR-001 still bind:

1. **The daemon runs locally** — the trust verifier reads `~/Projects` and the
   watcher reads `~/.claude/projects`. It cannot fully live elsewhere.
2. **The record is the user's** — every decision, rejection, and reason is a
   SQLite file on their disk. It must not become someone else's to hold.
3. **A verdict is never lost** (ADR-002's invariant), and a rejection always
   carries a reason.

Prior art already traced in ADR-002 supplies the delivery primitive: the
`claude/channel` capability from the official Discord plugin — an MCP server
emits `notifications/claude/channel` and a Claude Code session launched with
`--channels` turns each into an agent turn — plus that plugin's pairing model
(user-scoped in `~/.claude.json`, so it works headless, not only interactive).

## Decision

### 1. Separate the record from the mailbox — this is the spine

Two stores, never conflated:

- **Record of truth — local SQLite (FTS5).** Every decision, rejection, reason;
  the queryable library. Stays on the user's disk. Never leaves.
- **Mailbox — a small server-side store** that mediates delivery between the
  daemon and remote devices. It holds only: an **outbox** (pending decisions a
  device must pull), an **inbox** (verdicts and comments cast while the daemon
  was offline), and minimal routing metadata. Its properties are load-bearing:
  **ciphertext only** (end-to-end encrypted), **per-user isolated**, and
  **transient — cleared once both ends have acknowledged.** It is a delivery
  buffer, never the record. A breach or subpoena of it yields ciphertext with no
  keys.

Because *all* daemon↔device traffic goes through the mailbox, neither the phone
nor the daemon has to reach the other directly. The mailbox is the rendezvous —
which removes the need for any inbound reachability to the daemon, and therefore
supersedes the tunnel/`expose` line of work for the human leg.

### 2. Two transports, because the legs have different shapes

- **Daemon ↔ agent — the local channel.** Both live on the same machine, so this
  leg is local and needs no store. The daemon is a user-scoped MCP **channel
  source**; the agent launches with `--channels`; a verdict or comment becomes
  the agent's next turn. One update fanning out to several agents is the
  **1-to-many** mapping (each agent is a channel).
- **Daemon ↔ human devices — the mailbox.** Asynchronous, ciphertext, per-user.
  The daemon writes the outbox and reads the inbox; a device reads the outbox and
  writes the inbox.

### 3. The flows

The agent's session already holds the context, so a verdict is a *signal*, not a
context dump:

- **Approve** — phone → `inbox(approved)` → daemon drains → channel turn
  "approved" → the agent proceeds.
- **Reject** — phone → `inbox(rejected, reason)` → daemon → channel turn
  "rejected, here is why" → the agent stops or revises. Reason required.
- **Comment (P1)** — phone → `inbox(comment)` → daemon → channel turn → the
  agent answers or addresses the question.
- **Comment (P2, deferred)** — several role-agents each review a different
  aspect, grounded in the codebase via the codebase-memory MCP.

### 4. Pairing and trust

Pairing binds a daemon (and its devices) to an agent channel, modeled on the
Discord plugin: user-scoped config, an authorized handshake, headless-capable.
The local daemon is **open-source**, so a user can read exactly what it does —
trust by transparency, not by assertion. End-to-end encryption means the mailbox
operator, and anyone in the middle, sees ciphertext only.

## Consequences

- The mailbox is the *only* server-side storage in the system, and its discipline
  is the whole safety argument: transient, ciphertext, tenant-isolated, never the
  record. If it ever drifts toward being a durable copy of decisions, this ADR is
  violated.
- **No inbound reachability to the daemon is required.** The tunnel/`expose`
  work is superseded for the human leg; both the daemon and the devices make only
  outbound connections to the mailbox.
- The delivery guarantee holds by ADR-002's principle: the record is the local
  rows, and the mailbox and channel are optimizations over "drain on reconnect."
  A lost mailbox entry or a dropped channel costs latency, never a decision.
- **ADR-004 is a prerequisite.** The threat model's F1 finding says a verdict
  must be authenticated *as a verdict* regardless of transport. An inbox entry is
  applied only if it decrypts and authenticates under the user's key and is bound
  to a specific decision + version — so the mailbox operator cannot forge one.
  That redesign must land before this code is written.
- **Nonce discipline (threat model F5).** The encryption key is shared across a
  user's devices, so the AEAD must use random nonces (e.g. XChaCha20-Poly1305) or
  per-device subkeys — never counter nonces under a shared key.

## Open questions (explicitly not yet decided)

- **Mailbox entry shape.** Proposed minimum: `{ ciphertext, decision_id,
  version/seq, target }` — nothing more. To confirm.
- **Retention:** clear immediately on ack, or a short TTL as a lost-ack safety
  net?
- **Latency target** for outbox freshness — seconds, or is a minute acceptable?
  This sets whether the mailbox is polled or push-driven.
- **Sleeping-daemon reads.** For a phone to read a pending review while the
  daemon sleeps, the daemon must write the outbox at submit time. (Leaning yes.)
- **Offline scope.** Is a live daemon assumed for anything, or is every
  daemon↔device interaction mailbox-mediated?
- **Who runs the mailbox** — the user's own cloud account, or a shared operator.
  E2E makes both safe; tenancy and cost differ.
- **Pairing specifics** — key derivation and revocation — are downstream of
  ADR-004.

## Alternatives rejected

- **Pure tunnel, zero server storage** (the earlier framing) — rejected: it
  cannot span devices that are not co-present. The sleeping-laptop and
  offline-phone cases have no delivery path without a store.
- **Move the record off-disk** (Postgres/DynamoDB/Turso as the store of record) —
  rejected by ADR-001 and restated here: the record is the user's and stays on
  disk. The mailbox holds ciphertext, not the record.
- **A bespoke daemon→agent push** — rejected: `claude/channel` already turns an
  external event into an agent turn; reuse it rather than invent one.
