# ADR-004: A verdict authenticates itself — trust the message, not the transport

**Status:** proposed · **Date:** 2026-07-17 · **Project:** librarian

## Context

The threat model's **F1 (critical)** finding: a verdict has two authorization
paths, and only one is safe. The mailbox path requires the user's key; the direct
`POST /api/decisions/:id/verdict` route (live in `server.ts`) applies a state
change on the strength of a transport credential alone — the bearer token, plus
Cloudflare Access if present. Neither is out of reach for the transport itself:
Cloudflare terminates TLS, so it sees the token in plaintext, and Access is
Cloudflare's own product, so it can mint the JWT. A compromised or compelled
operator — or anyone who captures the token on the wire — can forge an
`approved`. The property "the daemon does not trust the edge" held for one path
and failed for the other, so it did not hold at all.

ADR-003 sharpens the stakes. Remote verdicts now arrive through the **mailbox
inbox**, delivered by an operator we have *explicitly decided not to trust*. If
the daemon applies an inbox entry because the mailbox handed it over, the mailbox
operator can forge approvals — defeating the entire ciphertext-only design.

The governing principle: **an `approved` makes an agent act.** Verdict authority
is the most sensitive capability in the system. It must not be grantable by
anything a transport can hold — not a token on the wire, not a JWT, not
possession of the mailbox.

This ADR is orthogonal to *delivery* (ADR-002's channel / resume / hooks,
ADR-003's mailbox). Those decide how a committed verdict reaches the agent. This
decides what the daemon is willing to commit in the first place.

## Decision

**A verdict — and a comment — is a self-authenticating message. The daemon
changes a decision's state only from (a) a loopback caller, or (b) a message that
cryptographically authenticates under the user's paired key and is bound to a
specific decision + version. No transport-level credential is ever, on its own,
sufficient to change a decision's state remotely.**

1. **Exactly two ways to move a decision.**
   - **Loopback** — the local web UI / CLI at the machine. Same trust as the
     shell (a local process already has that access); no signature required
     because you are physically there. `POST /api/decisions/:id/verdict` binds to
     loopback only.
   - **An authenticated message** — sealed on a paired device under the user's
     key, carried through the mailbox inbox (or any transport), applied only
     after the daemon verifies it.
   - There is **no remote, transport-credential-only path.** It is deleted.

2. **What "authenticated" means.**
   - Sealed with AEAD (XChaCha20-Poly1305, random nonce — threat-model F5) under
     a key derived from the pairing secret. A valid tag proves the message came
     from a holder of the key (a paired device / the human), never from the
     mailbox operator.
   - **Bound to `decision_id + version`** inside the authenticated data, so a
     valid verdict cannot be transplanted onto a different decision or an older
     version.
   - **Fresh.** Replay is defeated primarily by the one-way state machine — once a
     decision leaves `pending`, re-applying the same verdict is an
     `invalid_transition`, and this state is durable in SQLite — with
     version-binding covering the resubmit-to-`pending` case. A per-decision
     seen-nonce set, persisted in SQLite, is the belt-and-suspenders, and the
     *primary* defense for comments, which are append-only and have no idempotent
     state to lean on.

3. **The token and Access demote to reachability, not authority.** They gate who
   may *reach* the daemon or *write to* the mailbox — spam and DoS control. They
   never authorize a state change. Losing the token costs spam, not a forged
   verdict.

4. **The daemon trusts only the sealed fields.** It routes and applies by the
   `decision_id` and `version` *inside* the authenticated blob — never by the
   mailbox slot, the request path, or any operator-supplied metadata.

## Consequences

- "The daemon does not trust the transport" now holds **end to end**. The mailbox
  operator, Cloudflare, and anyone on the wire hold ciphertext plus a tag they
  cannot produce: they read nothing and forge nothing. A full mailbox compromise
  yields neither content nor authority.
- This satisfies the integrity half of ADR-003's goal (property 3) and is the
  stated prerequisite: **mailbox code cannot be written until this lands.**
- The local desk experience is unchanged — the web UI posts over loopback and is
  trusted as today. The only removal is the *remote* transport-credential verdict
  path.
- **Live-code impact.** Today, behind the F2/F3 auth gate, a tokened *remote*
  caller can still cast a verdict via `POST /api/decisions/:id/verdict`. After
  this ADR, that route rejects non-loopback callers; a remote verdict must be an
  authenticated message. This is the concrete close of F1.
- **Key management.** The AEAD key is shared across a user's own devices (derived
  from the pairing secret `k`; rotation = re-pair, per ADR-003). A shared
  symmetric key gives no per-device attribution or single-device revocation — the
  upgrade path is per-device keypairs with the daemon holding public keys, taken
  only if that need appears.
- **Nonce discipline is load-bearing.** Random-nonce XChaCha20-Poly1305, or
  per-device subkeys — never counter nonces under the shared key. A single nonce
  reuse forfeits both confidentiality and integrity (F5).

## Open questions

- **Symmetric vs asymmetric.** Decided symmetric (shared-key AEAD) for Phase 1 —
  one user, their own devices. Revisit for per-device revocation or "which of my
  devices approved this" attribution.
- **Comment freshness.** Comments authenticate identically; confirm they always
  carry the seen-nonce dedup (they must — append-only).
- **The loopback-trust assumption.** "At the machine = trusted" matches today's
  model. A shared or multi-user machine would need this revisited — out of scope
  for Phase 1.

## Alternatives rejected

- **Harden the token further (rotate, rate-limit, constant-time).** Rejected as
  the *fix*: F2/F3 already hardened the token for reachability, but no hardening
  changes that the operator sees the token and that a transport credential is the
  wrong thing to gate verdict authority on. This ADR moves authority off the token
  entirely.
- **Let the mailbox enforce that entries come only from authenticated devices.**
  Rejected: that is trusting the operator, which the ciphertext-only mailbox
  exists precisely to avoid.
- **Per-device keypairs / signatures now.** Deferred, not rejected — the right
  answer for multi-device attribution and revocation, but more machinery than
  Phase 1 needs. Named as the upgrade path.
