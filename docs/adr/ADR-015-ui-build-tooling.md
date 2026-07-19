# ADR-015: Keep the zero-build UI — split with native ES modules, not Vite (for now)

**Status:** proposed · **Date:** 2026-07-19 · **Project:** librarian · **Read time:** ~3 min

## TL;DR

- **Decision:** **don't** adopt Vite yet. The pain is real but it is *file length*, not *missing bundler* — and native ES modules solve that with **zero build**.
- **Why it matters here:** `public/` is served straight from the repo working tree, so a UI edit is live on refresh. Vite inserts a build artifact between editing and seeing — the exact staleness class that just cost us hours when a 17-hour-old `dist/` channel silently mis-routed messages.
- **Revisit when a real trigger fires** (below), not on general principle.

## What we actually have

| | Today |
|---|---|
| Size | `index.html` **805 lines**, `catchup.html` **385** — inline CSS + JS + a hand-rolled `md()` renderer |
| Build | **None.** `npm run build` is `tsc` for the backend + copying migrations |
| Serving | `express.static(<repo>/public)` — the working tree itself |
| Deps | **Zero** at runtime; mermaid is vendored (3.4 MB), not CDN'd |
| Types | Backend is TypeScript; **the UI is untyped JS** |

## What Vite would buy — and cost

**Buys:** component/file splitting · frontend type-checking · real libraries instead of hand-rolled (`md()`, diff) · HMR.

**Costs:**

1. ⛔ **A build step between edit and refresh.** Today: save, reload, done. This project has already been bitten hard by a stale build artifact — the channel binary in `dist/` was 17 hours old and silently declared no project, leaking messages across projects for an entire session. Adding a *second* artifact to keep in sync re-opens that failure mode on the surface a human stares at.
2. ⚠️ **Supply-chain surface on the verdict surface.** ADR-009 set the rule: the review UI is where verdicts are read and approved, so it **loads zero remote code** — mermaid was vendored specifically to honor that. A bundler brings a transitive npm tree into exactly that surface. ADR-014 just argued for treating this boundary more carefully, not less.
3. A dev server process (or a `dist/public` to serve and ship).
4. Bundle size and perf are **non-problems** — single user, loopback, one machine.

## The cheaper path that gets the main benefit

The complaint is one 805-line file. Browsers solve that natively — the page already uses `<script type="module">`:

```
public/
  index.html          ← markup + styles
  js/md.js            ← the markdown renderer
  js/chat.js          ← chat bar: selection, screenshots, drafts
  js/catchup.js       ← the briefing view
  js/api.js           ← fetch helpers, SSE
```

Imported natively, served by the same `express.static`, **no build, no dependencies, no staleness**. If types become the pain, JSDoc annotations + `tsc --checkJs` type the frontend without a bundler either.

## Decision

1. **No Vite now.** Keep zero-build; the costs land precisely on this project's demonstrated weak spot (stale artifacts) and its stated security posture (ADR-009).
2. **Split into native ES modules** when file length actually hurts — not as a rewrite, incrementally, starting with `md()` (the most self-contained and most testable piece).
3. **Optional next:** `tsc --checkJs` over `public/js` to get frontend type-checking with no bundler.

## Revisit if…

Any one of these makes Vite the right answer — none are true today:

- We adopt a **framework** (React/Svelte) because the UI grows genuinely stateful.
- We need a **real library** where hand-rolling stops paying — a full markdown/diff engine, virtualized lists for thousands of decisions.
- We want **frontend tests + types** as first-class, and `checkJs` proves too weak.
- Librarian ships to **other people** and asset size/caching starts to matter (today: one user, loopback).

## Consequences

- **Buys:** edit-and-refresh stays instant; the verdict surface keeps its zero-dependency guarantee; no second build artifact to go stale.
- **Costs:** we keep maintaining `md()` by hand (it has already needed tables, mermaid, callouts, soft breaks); no frontend types until `checkJs`; module splitting is manual.
- **Honest caveat:** this is a "not yet," not a "never." The triggers above are the decision criteria, so the next person doesn't have to re-litigate it from taste.

## Related

ADR-009 (vendored mermaid — the zero-remote-code rule this protects) · ADR-014 (channel security — same instinct about the verdict surface) · ADR-005 (clean architecture — the backend seam; this is the UI's counterpart choice).
