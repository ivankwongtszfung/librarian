# 📚 Librarian

**A decision library for AI agent sessions.** Agents submit their plans and architecture docs over MCP; you read them, comment, and green- or red-light them from any device; every verdict — including every rejection — becomes memory that the agents themselves can query before they design anything else.

*Rent the conversation. Own the decisions.*

---

## The problem

You run five or six agent sessions at once. Each one produces plans, ADRs, and design docs that are buried inside a linear chat transcript. One chat cannot show you many decisions. So:

- Decision docs scatter across repos and sessions; there is no one place to read them.
- Sessions sit blocked on approval while you are looking at a different terminal.
- Approvals get rubber-stamped, because the doc and the approve button live in different places.
- **Rejections vanish.** A red light shapes a design as much as a green light does — but nothing records it, so a fresh session cheerfully re-proposes the idea you turned down last week.

## What Librarian does

One small daemon on your machine, holding one SQLite file:

- **An MCP server** any agent can talk to — Claude Code, Codex, or your own. Agents submit designs and wait for your verdict.
- **A library** — every decision, across every project, in one structured view instead of buried in chat.
- **A red-light memory** — rejections are first-class records, and agents can query them (`get_constraints`) *before* proposing, so you stop re-litigating the same bad idea.
- **A safety net** — a watcher reads your agent transcripts and captures decision docs even when the agent forgets to submit one.

Everything stays on your disk. There is no cloud, no account, and no telemetry.

## Install

```bash
git clone https://github.com/ivankwongtszfung/librarian.git
cd librarian
npm install
npm run build
npm start
```

Then point an agent at it:

```bash
claude mcp add --transport http librarian http://127.0.0.1:7801/mcp
```

Open **http://127.0.0.1:7801** to read the library.

Add this to your agent's instruction file (`CLAUDE.md`, `AGENTS.md`) to close the loop:

> Before proposing any design or plan, call `get_constraints` for the project to see what has already been decided and rejected. Before finalizing one, call `submit_for_review` and poll `get_review` until it resolves.

## The tools an agent gets

| Tool | When the agent calls it |
|---|---|
| `get_constraints(project, topic?)` | **Before designing.** Queryless on purpose — you can't search for a constraint you don't know exists. Returns what was approved *and what was rejected, with reasons*. |
| `search_decisions(query, …)` | Mid-design, for a specific question: "has Redis been considered here?" Searches every decision, including rejected ones. |
| `submit_for_review(project, title, doc, …)` | Before acting on a design. Returns a `review_id`. |
| `get_review(review_id, wait_seconds)` | Waits for your verdict (server-side long-poll, ≤50s per call). Resolves to `approved`, `rejected` + reason, or `changes_requested` + your comments. |
| `record_decision(…)` | Files a decision that needs no approval. Doesn't gate, doesn't notify. |

For reviews that may take a while, an agent shouldn't sit in a polling loop — it can run

```bash
librarian wait <review_id> --timeout 2h   # exit 0 = resolved (verdict JSON on stdout),
                                          # exit 1 = error, exit 2 = still pending
```

as a **background process** and end its turn: the process holds the long-poll (reconnecting through daemon restarts), and its exit is what wakes the agent's harness with the verdict. Zero tokens are spent waiting.

## How a decision flows

1. An agent finishes a design and calls `submit_for_review`.
2. It appears in your library as **pending**, and your phone buzzes (if you set `--ntfy`).
3. You read the doc — the whole point — then **approve**, **reject with a reason**, or **comment and request changes**.
4. The agent's `get_review` resolves. On changes, it reads your comments, revises, and resubmits with `parent_review_id`; you get a **v1 → v2 diff**, so re-reading costs seconds.
5. The verdict is recorded forever, comments and all. The thread *is* the decision's rationale.
6. The next agent that calls `get_constraints` sees it — including the red light.

## Design notes

**A rejection must carry a reason.** The API refuses a red light without one (`422`), and so does the database. A rejection that doesn't say why isn't a decision, it's a shrug.

**Verdicts are append-only.** `rejected → revised → approved` is the shape of a real decision record, and none of it is ever overwritten. That chain is exactly the "alternatives considered" section nobody writes by hand.

**The long-poll cannot lose a verdict.** `get_review` is an idempotent read reconstructed from committed rows. A dropped connection, a re-poll, or a daemon restart all return the same answer — losing the connection costs latency, never a decision.

**One decision is one thread.** A revision adds a version to the same decision; it does not mint a new one. Doc, comments, and verdict history stay together.

## Options

```
librarian [options]

  --port <n>        HTTP port (default 7801)
  --host <addr>     bind address (default 127.0.0.1)
  --db <path>       SQLite file (default ~/.librarian/librarian.db)
  --token <secret>  require a bearer token on /api
  --ntfy <url>      ntfy topic URL for push notifications
  --watch [dir]     auto-capture from agent transcripts (default ~/.claude/projects)
  --no-watch        disable transcript capture
```

**Reading from your phone.** The daemon binds to localhost by default. To reach it from a phone, run it behind [Tailscale](https://tailscale.com) (`--host 0.0.0.0 --token <secret>`) and open the tailnet address. The auth layer is transport-agnostic on purpose — a bearer token is what authorizes a request, not the interface it arrived on — so LAN, Tailscale, or a future relay are interchangeable.

## Development

```bash
npm run dev      # watch mode
npm test         # unit tests (vitest)
npm run bdd      # acceptance scenarios (cucumber)
npm run check    # lint + typecheck + all tests
```

The `.feature` files under `tests/features/` are the acceptance criteria, not decoration — they drive a real daemon over real HTTP with a real MCP client.

## Status

Phase 1. The review loop works end to end; the library is browsable; the watcher captures decisions from Claude Code transcripts.

Not built yet: the reviewer panel (role-scoped agents that pre-review each doc — the "librarian" consistency checker is the interesting one), context verification against the local repo, the native iOS app, and a chat surface for notifications.

## Licence

MIT
