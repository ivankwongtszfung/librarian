# CLAUDE.md

Librarian is a local-first decision library for AI agent sessions: agents submit
plans/ADRs over MCP, a human green- or red-lights them, and every verdict —
especially rejections — becomes queryable memory (`get_constraints`). The thesis
the whole design serves: **red lights are decisions too, and a rejection always
carries a reason.**

Where things are written down: `README.md` (usage, tool table) ·
`docs/prd.md` (product) · `docs/backend-plan.html` (ADRs B1–B9, domain model,
the BDD spec) · `docs/adr/` (live decisions about this project itself).

## Commands

```bash
npm run check      # THE gate: lint + typecheck + unit + BDD. Green before any commit.
npm test           # vitest + cucumber
npm run test:unit  # vitest only
npm run bdd        # cucumber only
npm run lint:fix   # Biome owns style — never hand-format
npm run dev        # tsx watch
npm run build      # tsc + build:assets (copies .sql — see traps)
```

Smoke test after ANY build/packaging change:

```bash
npm run build && node dist/cli.js --db /tmp/s.db --port 7899 --no-watch &
curl -s http://127.0.0.1:7899/api/health   # expect {"ok":true,...}
```

Tests run from source via tsx and **cannot** catch packaging breakage — only
this can. It already caught a shipped-with-no-migrations bug once.

## Invariants — do not break

- **Verdicts are append-only events** (`verdict_events`); `decisions.status` is
  a denormalized cache, never the record. `rejected`/`changes_requested` require
  a reason — enforced three times on purpose (state machine, SQL CHECK, HTTP
  422). Keep all three; they guard different doors.
- **`get_review` is an idempotent read** reconstructed from committed rows. The
  `EventBus` only wakes waiting long-polls early — it is a latency optimization,
  never the delivery mechanism. Do not refactor verdict delivery into in-memory
  pub/sub; the reconnect/restart scenarios in `tests/features/longpoll.feature`
  exist to fail exactly that change.
- **One decision = one thread.** A resubmission with `parent_review_id` adds a
  version to the *same* decision (`rejected → pending` is a legal transition);
  it must never mint a new decision. The doc, the comments, and the red light
  that prompted the rewrite stay together.
- **The watcher never throws on transcript content.** Extractors in
  `src/watcher/extract.ts` are guarded pure functions; an unknown shape degrades
  to a missed capture, never a crash. Only `<project-slug>/<uuid>.jsonl` files
  are sessions — skip `subagents/` and `workflows/` or decisions double-count.
  Approved vs rejected plan: top-level `toolUseResult` is an object with a
  `plan` key (approved) vs the literal string `"User rejected tool use"`
  (rejected). Don't key off result prose; its wording drifts across versions.
- **MCP is stateless.** A fresh `McpServer` + transport per POST; pass the
  pre-parsed `req.body` to `handleRequest` (express.json already consumed the
  stream). Tool `inputSchema` takes a raw zod shape (`{ q: z.string() }`),
  not `z.object()`.
- **Shutdown must stay clean.** `requestTimeout = 0` is required for the
  long-poll and SSE, which means idle keep-alive sockets never expire — so
  `daemon.stop()` must keep its `closeAllConnections()`, and long timers get
  `unref()`. If `npm test` prints green and then hangs, that is a leaked
  handle and a product bug (the daemon would hang on SIGTERM too). Fix it,
  don't force-kill it.
- **Auth is transport-agnostic.** The bearer token authorizes a request, never
  the interface it arrived on. That is what keeps localhost, LAN, Tailscale,
  and a future relay interchangeable (see `docs/adr/ADR-001-deployment.md`).

## Conventions

- **BDD-first.** `tests/features/*.feature` are the acceptance spec, not
  decoration: new behavior gets a scenario before code. Steps drive a real
  daemon + real MCP client over real HTTP — no mocks in the middle.
- Cucumber loads TS through `tests/tsx-register.js` (tsx `--import` API);
  never reintroduce `--loader`.
- Express 4 is paired with `@types/express@^4` — bump both or neither.
- `build` must keep `build:assets`: tsc does not copy `.sql` files.
- **Dogfood.** Significant decisions about Librarian land in `docs/adr/` and,
  when the daemon is running, go through `submit_for_review` itself — see
  `scripts/first-decision.mjs` for the pattern.
