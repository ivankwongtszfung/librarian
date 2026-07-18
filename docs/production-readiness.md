# Production readiness — the gap

**Date:** 2026-07-17 · **Status:** assessment · grounded in the repo as of `fa3687b`

A catch-up on what stands between Librarian today and a version other people can
install and rely on. Read the fork first — it doubles or halves everything below.

## The fork that sets the scope

**What does "production" mean here?**

- **v1 — a solid local tool.** A developer installs it, it runs as a managed
  background service on their own machine, survives reboots and crashes, and they
  trust it with their decision history. Single-user, local. *This is achievable in
  ~1–2 focused weeks and is mostly operational plumbing.*
- **v2 — remote / multi-user.** The cross-device build (ADR-003/004): the encrypted
  mailbox, the `claude/channel` transport, verdict authentication. *This is a
  feature effort of its own, on top of v1.*

The gaps below are tagged for which target they block. **Recommendation: ship v1
first** — it's the credible "production" bar, and v2 rides on it.

## What's already production-grade (not gaps)

Credit where due, so we don't re-solve solved things:

- **The core loop works and is tested** — 41 unit + 22 BDD green, MCP + REST + SSE
  + web UI + SQLite/FTS5 + transcript watcher, all on `main`.
- **Clean layering** — the `DecisionStore` port + layer folders (ADR-005) mean new
  storage/transport slots in as an adapter, not surgery.
- **Graceful shutdown** — SIGINT/SIGTERM handlers close the server and DB cleanly.
- **The invariants are hard** — reasons-required is enforced three ways (state
  machine, SQL CHECK, HTTP 422); verdict delivery is reconstructed from committed
  rows, so a dropped connection costs latency, never a decision.
- **Auth basics landed** — `/mcp` gated, constant-time token, no query-string
  leak, non-loopback bind refuses to start without a token (F2/F3).

## The gap, prioritized

| # | Gap | Today | Blocks | Effort |
|---|-----|-------|--------|--------|
| 1 | **No CI** | `.github/` absent; tests run only locally | v1 | ~2 h |
| 2 | **No managed service** | daemon dies with the terminal | v1 | ~1–2 d |
| 3 | **No crash supervision** | no `uncaughtException`/`unhandledRejection` handler | v1 | ~0.5 d |
| 4 | **Unstructured logging** | 12 `console.*` calls, vanish with the terminal | v1 | ~0.5–1 d |
| 5 | **No backup / export** | the SQLite file is the user's only copy | v1 | ~1 d |
| 6 | **No release pipeline** | not on npm; no semver/tags/CHANGELOG | v1 | ~0.5–1 d |
| 7 | **Thin ops docs** | README only; no install guide, SECURITY.md, config ref | v1 | ~1 d |
| 8 | **Verdict auth unbuilt** | ADR-004 decided, not implemented | v2 | ~2–3 d |
| 9 | **Cross-device unbuilt** | ADR-003 mailbox/channel/pairing | v2 | ~1–2 wk |
| 10 | **Delivery chain partial** | `wait` shipped; hooks/channel/resume/Discord not | v2 | ~1 wk |
| 11 | **No load/concurrency tests** | single-writer SQLite + long-poll fan-out untested at scale | v2 | ~1–2 d |

## v1 — the minimum to call it "production" (local)

The six that actually gate a credible local release, in build order:

1. **CI (gap 1).** A GitHub Actions workflow running `npm run check` on every PR.
   Cheapest, highest leverage — it makes every later change safe. Do this first.
2. **`librarian install` (gap 2).** Register the daemon as a per-user service —
   `launchd` plist on macOS (`KeepAlive`), `systemd --user` unit on Linux
   (`Restart=always`). This is ADR-001's recommended tier, still unbuilt, and it's
   the single biggest thing between "a script I run in a terminal" and "a tool."
3. **Crash supervision (gap 3).** Top-level `uncaughtException` /
   `unhandledRejection` handlers that log and exit non-zero, so the service
   supervisor restarts a wedged daemon instead of it dying silently.
4. **Logging to a file (gap 4).** A minimal leveled logger; the service captures
   stdout/stderr to a rotatable logfile. Right now a crash leaves no trace.
5. **`librarian export` + backup docs (gap 5).** The decision archive is
   irreplaceable and lives in one SQLite file. Ship a JSON/markdown export and
   document the (trivial) file-copy backup — a production tool must not be able to
   lose the user's data to a corrupt DB.
6. **Release + docs (gaps 6, 7).** `npm publish` with semver, a CHANGELOG, a
   SECURITY.md (disclosure contact), and a real install/ops section in the README.

Everything else is v2 (the remote build) or post-launch hardening.

## Detail by area

### Reliability & operations (gaps 2, 3)
The daemon assumes a human is watching a terminal. Production assumes nobody is.
Needed: a supervised service that restarts on crash and at login, plus process-level
crash handlers so an unexpected throw is logged and recovered rather than fatal.
Graceful shutdown is already done — this is the other half.

### Observability (gap 4)
`console.*` is fine for dev and invisible in production. Needed: leveled logging
(info/warn/error), a stable line format, and output the service can rotate. A
per-request/verdict audit line is a cheap, high-trust addition — "who decided what,
when" written append-only.

### Data durability (gap 5)
SQLite-in-a-file is a strength (zero-ops, easy backup) but there's no export and no
stated backup story. A `librarian export` (and `import`) also gives portability and
answers "what if the DB corrupts." One file, so backup is a copy — but that has to be
documented, not assumed.

### Distribution & install (gaps 1, 6)
No CI means no automated gate on contributions or releases. No publish pipeline means
no versioned artifact to install. `better-sqlite3` is a native module — prebuilds
usually cover the common platforms, but support should be stated, and the
compile-to-single-binary path (see the Rust decision doc) is the escape hatch if
install friction becomes the adoption blocker.

### Security (gap 8) — build the decided design
The token gate (F2/F3) is in. The open item is **ADR-004 (verdict authentication)**:
a verdict must authenticate under the user's key, not a transport credential. This is
**not exploitable while the daemon is loopback-only**, so it does not block a local
v1 — but it is a hard prerequisite before *any* remote exposure (v2). Implement it
with the mailbox, never before it's needed. Rate limiting and a verdict audit log are
post-launch hardening.

### Feature completeness (gaps 9, 10) — v2
Cross-device (ADR-003) and the richer agent-delivery chain (ADR-002: hook installer,
channel MCP server, resume adapter, Discord bridge) are real features, not hardening.
They ride on the ports from ADR-005. Sequence them after v1 and after the open
ADR-003 questions (mailbox retention, entry shape) are closed.

## Suggested sequence

1. **CI** (gap 1) — do it before anything else touches the code.
2. **Service + supervision + logging** (gaps 2, 3, 4) — the "it's a real daemon" bundle.
3. **Export + backup docs** (gap 5) — protect the data.
4. **Release + docs** (gaps 6, 7) — cut a v1.0.0.
5. *(v2)* **Verdict auth → mailbox → channel** (gaps 8, 9) — the remote build, on the ports.

## Trivia to sweep while nearby
- `.gitignore` still lists `state.html` (a removed file) — harmless, delete when convenient.
