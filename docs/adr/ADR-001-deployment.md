# ADR-001: How Librarian is deployed

**Status:** proposed · **Date:** 2026-07-12 · **Project:** librarian

## Context

Librarian is a daemon that must be running whenever agent sessions are running, because a session that submits a design for review will block on `get_review` until a verdict arrives. If the daemon is down, the agent waits on a review nobody can see.

Two properties constrain every option below, and they are not negotiable:

1. **The trust layer needs the code.** Librarian verifies that a design's cited files and functions actually exist by reading the repos on this machine. A daemon that cannot see `~/Projects` cannot do the one thing no SaaS competitor can do.
2. **The decisions are the user's.** The store is a SQLite file on the user's disk. Any deployment that moves it somewhere the user doesn't own contradicts the product.

The question is therefore not *where in the cloud* Librarian runs. It is *how the local process gets started and stays up*, and how a phone reaches it.

## Options considered

### A. Run it by hand (`npm start` in a terminal)

What we do today. Zero setup, zero magic, and it dies with the terminal — the failure mode is a session blocked on a review that no longer has a daemon to deliver it. Fine for development, unacceptable as the answer for a user.

### B. launchd / systemd user service (recommended)

The daemon is registered as a per-user background service: it starts at login, restarts if it crashes, and writes logs where the OS expects. On macOS this is a `~/Library/LaunchAgents/*.plist` with `KeepAlive`; on Linux, a `systemd --user` unit.

- **Cost:** one `librarian install` subcommand that writes the plist/unit, plus an `uninstall`. Perhaps 80 lines.
- **Failure mode:** none that matters — if it dies it comes back.
- **Caveat:** a sleeping laptop still serves nothing. This is inherent to local-first and is a documentation problem (`caffeinate`), not a deployment one.

### C. Docker container

Portable and clean — but it *breaks requirement 1*. The trust layer would need `~/Projects` and `~/.claude/projects` bind-mounted into the container, and the watcher would need host filesystem events to cross that boundary reliably. We would be paying container tax to make a local-first tool worse at being local.

### D. Hosted service (a VPS, Fly.io, Railway)

Contradicts both requirements outright: the code isn't there to verify against, and the user's decisions now live on someone else's disk. This is not a deployment option; it is a different product, and one whose only differentiators are the two we would be giving up.

### E. Hosted **relay** (not the daemon — just a pipe)

A stateless, end-to-end-encrypted relay that lets a phone reach the daemon when the two are not on the same network. The daemon dials *out* to the relay, so there is no port forwarding, no inbound firewall hole, and no VPN requirement. The relay stores nothing and can read nothing. This is what Plex and Home Assistant Cloud do, and it is the only piece of Librarian that could ever justify a server bill.

It is **not needed for v1**, because Tailscale (which many of this tool's users already run) solves remote reach for free, and the LAN case needs nothing at all.

## Decision

**Adopt B: a per-user background service, installed by `librarian install`.** Distribution is `npm`/`npx` and eventually Homebrew.

Connectivity is tiered, and Tailscale is explicitly *not* a hard dependency:

| Tier | Reach | Requires |
|---|---|---|
| 0 | The daemon and the web library on this machine | nothing |
| 1 | A phone on the same Wi-Fi | nothing — mDNS discovery, QR pairing, bearer token |
| 2 | A phone anywhere | Tailscale if present; otherwise the relay (E), self-hostable |

Auth stays transport-agnostic: a bearer token authorizes a request, never the interface it arrived on. That is what keeps tiers 1 and 2 interchangeable.

## Consequences

- Users get a daemon that is simply *always there*, which is the only way the review loop can be trusted to deliver a verdict.
- We owe an `install` / `uninstall` subcommand, and it must be genuinely reversible — a tool that quietly installs a permanent background service and cannot cleanly remove it has abused the user's machine.
- The relay (E) remains designed-but-unbuilt. If it is ever built, it stores nothing; the moment it stores decisions, it becomes option D wearing a disguise.
- A sleeping Mac serves nothing. Documented, not solved.

## Alternatives rejected

- **Docker (C)** — rejected: bind-mounting the user's entire home directory to restore the trust layer defeats the point of the container.
- **Hosted service (D)** — rejected: destroys both the trust layer and data ownership, which are the only two things a SaaS competitor cannot copy.
- **Manual `npm start` (A)** — rejected as the shipped answer: a blocked review with no daemon behind it is the worst failure this product can have.
