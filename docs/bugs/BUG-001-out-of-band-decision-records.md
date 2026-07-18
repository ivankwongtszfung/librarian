# BUG-001: Decision records outside `docs/` are invisible — and the library looks complete anyway

**Kind:** bug · **Severity:** medium · **Date:** 2026-07-18 · **Project:** librarian · **Status:** mitigated, root causes open

## Symptom

> ⛔ The reviewer's résumé system has a real decision record (`~/Projects/resume/README.md` — canonical design, four tailoring levers, "never invent experience") and librarian showed **nothing**: no project, no record, no constraint. Worse, nothing indicated anything was missing — an agent calling `get_constraints("resume")` would get an empty, confident answer.

The dangerous part is not the gap; it is that **the library cannot tell you about its own blind spots**.

## Reproduction

1. Write a decision-shaped markdown anywhere outside a `docs/` directory (or before the daemon existed, or from a session whose cwd never hosted one).
2. Open the catchup — the project either misses entirely or shows nothing recorded.
3. `get_constraints` for that project returns empty with no hint that reality disagrees.

## Root causes — three, stacked

| # | Cause | Where | Deliberate? |
|---|-------|-------|-------------|
| 1 | The watcher never replays history — pre-daemon transcripts are skipped by cursor design | `watcher.ts` (cursor = end-of-file on first sight) | ✅ yes — replay would flood |
| 2 | Doc capture requires a `docs/` path: `DOC_PATH = /\/docs?\/.*\.mdx?$/i` | `extract.ts:131` | ✅ yes — noise filter (career-ops alone has 15 loose `.md` files) |
| 3 | A project whose sessions never ran is not even *observed*; a project with no captured decisions renders as "nothing", identical to "nothing exists" | `server.ts` observedProjects | ⚠️ partially — observed-projects (PR #15) narrowed this, but only for projects with transcript dirs |

Each choice is individually sound; **stacked, they produce silent incompleteness**.

## What has been done (mitigation, not fix)

- ✅ The résumé record was backfilled via `record_decision` (project `resume`, honestly dated 2026-07-10) — `get_constraints("resume")` now serves the "never invent experience" invariant.
- ✅ Observed-but-empty projects render on the catchup as "librarian is blind here" (PR #15).
- ✅ ADR-001…006 were backfilled the same way when the identical gap surfaced for librarian's own history.

## Remaining risk

Any decision record that is (a) older than the daemon, (b) outside a `docs/` tree, or (c) from a machine-context librarian never watched, stays invisible — and every backfill so far happened because a **human noticed**. The failure mode repeats until discovery is systematic.

## Fix options (for a future decision — this report decides nothing)

1. **`librarian import <path>`** — a deliberate CLI to walk a directory, propose decision-shaped files, and record them with honest dates. Discovery stays human-triggered but becomes one command instead of an agent session.
2. **Blind-spot audit on the catchup** — for each observed project, show "N markdown docs seen in transcripts that were never captured," making the gap visible where the reviewer already looks.
3. **Widen `DOC_PATH`** — rejected as a default: every README/CHANGELOG write becomes a capture, multiplying fabricated-approval noise while the ADR-008 watcher build is still pending.

Recommendation: option 1, small and honest; option 2 as its companion once ADR-008's build lands.

## Related

ADR-008 (watcher captures carry no authority — the same "silently wrong library" family) · PR #15 (observed projects) · the resume backfill (`dec_7340a8abeb3b45148e76`).
