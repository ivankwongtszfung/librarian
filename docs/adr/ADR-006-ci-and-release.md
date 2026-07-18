# ADR-006: CI and releasing Librarian

**Status:** proposed · **Date:** 2026-07-17 · **Project:** librarian

## Context

Productionizing (see `docs/production-readiness.md`) surfaced two gaps that are
about *how the project is developed and shipped*, not runtime behaviour, and both
set conventions worth recording:

- **No CI** — `.github/` is absent; the test suite runs only on a developer's
  machine, so nothing gates a pull request or a merge.
- **No release pipeline** — not on npm; no semver discipline, tags, or CHANGELOG.
  Install today is "clone and build."

This ADR decides both. It is a companion to the operational work (service
install, logging, export) tracked in the production-readiness doc; those are
being built, these are being *decided* so the build has a target.

## Decision

### CI

- A GitHub Actions workflow (`.github/workflows/ci.yml`) that runs
  **`npm run check`** — lint + typecheck + unit + BDD — on every push and pull
  request, across a Node version matrix down to the `engines` floor (≥20.11).
- Green CI is **required to merge** to `main` (branch protection).
- Cache npm; the suite is ~10s, so nothing else needs optimizing.

### Release

- Publish to npm as **`@ivankwong/librarian`** (the existing scoped name).
- **Semver**, with `main` always releasable. A pushed tag `vX.Y.Z` triggers a
  release workflow: `npm run check` → `npm publish` → GitHub Release.
- **CHANGELOG.md** (Keep-a-Changelog style), updated per release.
- The published artifact is `dist/` + `src/infrastructure/store/migrations` +
  `public` — already the `files` allow-list in `package.json`.

### Native module & install path

- `better-sqlite3` ships prebuilt binaries for the common platforms; document the
  supported set and the build-from-source fallback (needs a compiler toolchain).
- **Escape hatch** (see the Rust decision doc): if install friction ever becomes
  the adoption blocker, compile the CLI to a single executable with
  `bun build --compile` or Node SEA, sidestepping the Node + native-module install
  entirely. Not now — only when a real complaint appears.

## Consequences

- Every change is gated by the same `npm run check` a human runs locally — no
  drift between "works on my machine" and merged.
- A user installs with `npm i -g @ivankwong/librarian` (or `npx`), then
  `librarian install` to run it as a background service.
- Releases are reproducible from a tag; contributors get a green-check signal.

## Open questions

- **Provenance / signing** (npm provenance, sigstore) — defer until there are
  external users to protect.
- **Prerelease channel** (a `next` dist-tag) — add only if the cadence needs it.

## Alternatives rejected

- **No CI, trust local `npm run check`.** Fine for a solo author; breaks the moment
  a second contributor or a hurried merge appears. CI is cheap insurance and the
  suite is already fast.
- **Ship as a git clone only.** A production tool needs a one-command install; npm
  is the least-friction path for a Node CLI, with the single-binary compile as the
  escape hatch.
- **A release-automation framework (changesets, semantic-release).** Overkill for a
  solo cadence; a tag-triggered workflow plus a hand-kept CHANGELOG suffices until
  the release rate justifies more.
