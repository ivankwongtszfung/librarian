# ADR-005: Adopt Clean Architecture — the Dependency Rule, applied lightly

**Status:** proposed · **Date:** 2026-07-17 · **Project:** librarian

## Context

We want the codebase to follow Clean Architecture. The binding principle — the
only mandatory one — is Robert C. Martin's **Dependency Rule**:

> "Source code dependencies can only point inwards. Nothing in an inner circle
> can know anything at all about something in an outer circle." — *The Clean
> Architecture* (blog.cleancoder.com, 2012)

The four concentric layers (Entities → Use Cases → Interface Adapters →
Frameworks & Drivers) are the usual illustration, but Martin is explicit in the
same post that **they are schematic**: "You may find that you need more than just
these four… However, The Dependency Rule always applies." That sentence is what
lets a small daemon adopt the rule without the heavy apparatus — and doing so is
a deliberate application of this project's YAGNI stance, not a departure from it.

**The current code is already ~70% compliant** — this is a formalize-and-fix, not
a rewrite. Ground truth from the import graph:

- `domain/` is **pure**: `state-machine.ts` imports only `./types`; `types.ts`
  imports nothing. The inner core already depends on nothing outward. ✅
- `Notifier` is **already a port** — an interface with `MemoryNotifier` /
  `NtfyNotifier` adapters. This is the exact pattern to copy everywhere. ✅
- `daemon.ts` is **already a manual composition root** — it news up the concretes
  and wires them together. ✅

**The one violation that matters:** the concrete `Repository` (raw SQL over
`better-sqlite3`) is imported by the use-case layer and the controllers —
`core/review-service.ts`, `http/server.ts`, `mcp/server.ts`, `watcher/watcher.ts`
all `import { Repository }`. A use case depending on a concrete gateway is a
dependency pointing *outward*. Everything else is naming and folder legibility.

## Decision

**Adopt the Dependency Rule as the binding constraint, in a light four-region
layout, and fix the one real violation by introducing a store port. Explicitly
decline the ceremony that the rule does not require.**

### Layout (rename for legibility; the rule is what's enforced)

```
src/
  domain/          entities + pure rules + PORT interfaces
                   (types.ts, state-machine.ts, ports.ts)
  application/     use cases — depend only on ports
                   (review-service.ts)
  infrastructure/  adapters & drivers — implement ports, wrap frameworks
                   store/ (sqlite-decision-store.ts ← repository.ts, db.ts, migrations)
                   events/ (event-bus.ts)   notify/ (ntfy, memory)
                   watcher/ (watcher.ts, extract.ts)
  interfaces/      controllers — adapt a transport to the use cases
                   (http/server.ts, mcp/server.ts)
  main/            composition root + entrypoints (daemon.ts, cli.ts, wait.ts)
  util/            pure, dependency-free helpers (diff, duration, ids)
```

### The one load-bearing change — a store port

`domain/ports.ts` declares the interface the inner layers actually use; the SQLite
class implements it; the concrete is named only at the composition root:

```ts
// domain/ports.ts  — owned by the inner layer
export interface DecisionStore {
  submit(input: SubmitInput): SubmitResult;
  reviewOutcome(id: string): ReviewOutcome | null;
  applyVerdict(v: VerdictInput): VerdictEvent;
  addComments(...): Comment[];
  search(q: string, f?: SearchFilters): SearchHit[];
  constraints(project: string, topic?: string): Constraints;
  // …the methods the application + interface layers actually call
}

// infrastructure/store/sqlite-decision-store.ts
export class SqliteDecisionStore implements DecisionStore { /* today's Repository, verbatim */ }

// application/review-service.ts
constructor(private store: DecisionStore, private bus: EventBus, private notifier: Notifier) {}
```

`EventBus` becomes a port too (it is already abstract in spirit). `Notifier` is
left exactly as-is — it is already the model.

### What we deliberately do NOT do (and why)

The honest counterpoint to Clean Architecture is that its *full apparatus* is
where over-engineering hides. We decline it on purpose:

- **No DTO/mapper per layer.** The store already returns domain-shaped objects
  (`ReviewOutcome`, `Decision`), not raw rows. Adding a mapping layer to move a
  field would be the "maintainability nightmare" the critiques name. Reuse the
  shape.
- **No interface for a single implementation with no test seam.** `DecisionStore`
  and `EventBus` earn their ports (a second impl is coming — the mailbox — and
  they're the test seams). `diff`, `duration`, `ids` do not get ports.
- **No DI container.** The manual composition root in `main/daemon.ts` already
  works; constructor injection + one wiring file is the recommended shape at this
  size. A container (tsyringe/Inversify) is exactly the ceremony to avoid.
- **No vertical-slice reorg.** Noted as a defensible alternative (Hickey's
  cohesion argument), but at ~18 files layer-based folders are legible and the
  disruption isn't worth it.

## Why now — the payoff is the cross-device work

This isn't architecture for its own sake. ADR-003/004 add **new infrastructure**:
the encrypted mailbox, the `claude/channel` transport, the verdict-auth crypto.
If the use cases depend on **ports**, those slot in as adapters behind an
`OutboundDelivery` / `InboundVerdicts` port **without touching the domain or the
use cases** — the mailbox becomes a plug-in, not surgery. Fixing the
concrete-store violation *now*, before that code exists, is what keeps the
cross-device feature from threading framework details back through the core.

## The rework, phased (behavior-preserving; tests green at each step)

- **Phase 1 — ports + the fix (no folder moves yet).** Add `domain/ports.ts`
  (`DecisionStore`, `EventBus`). Make `Repository implements DecisionStore` and
  `EventBus` implement its port. Change `ReviewService` and the controllers to
  depend on the port types, not the concrete classes. Wiring in `daemon.ts` is
  unchanged (it still news up the concretes). This is the high-value, low-risk
  step — pure type-level indirection; all 41 unit + 22 BDD stay green.
- **Phase 2 — the folder moves.** Relocate files into
  `domain/application/infrastructure/interfaces/main`, rename `repository.ts` →
  `infrastructure/store/sqlite-decision-store.ts`, and update imports + the
  `index.ts` barrel + test import paths. Mechanical, reviewed as one diff.

## Consequences

- Behavior is unchanged; the guard is the existing suite — nothing ships until
  it's green after each phase.
- One ongoing discipline to hold: **no framework or DB types cross inward.**
  `express.Request`, `better-sqlite3` rows, MCP SDK types stay in `interfaces/`
  and `infrastructure/`; the domain and application layers never import them.
  (Today's `domain/` already honors this — the job is to keep it true.)
- The `index.ts` public barrel and the tests' `../../src/...` imports change in
  Phase 2; that's the bulk of the churn and it's mechanical.
- Adding the mailbox/channel later touches only `infrastructure/` + one port
  declaration — the win this ADR is buying.

## Alternatives rejected

- **The full four-layer apparatus with DTOs and mappers per layer.** Rejected as
  ceremony: the documented failure mode (layer explosion, pass-through mappers,
  editing eight files to add a field). We take the rule, not the apparatus.
- **Vertical-slice / feature-folder architecture.** Not rejected on merit —
  defensible, and stronger on cohesion — but the layer-based layout is legible at
  this scale and closer to where the code already is. Revisit if feature count
  grows.
- **Do nothing (leave the concrete store in the use case).** Rejected: it's the
  one violation that would force the cross-device transports to thread through the
  core. Fixing it is the cheapest right before that code is written.
- **A DI container.** Rejected: the manual composition root is sufficient and
  dependency-free; a container is ceremony at this size.
