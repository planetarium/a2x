# Agent Instructions

This file documents contribution conventions for human and AI contributors working on this repo. Claude Code, Cursor, and other agents that read `AGENTS.md` should follow these rules.

## Repo at a glance

```
packages/a2x/       @a2x/sdk — the A2A protocol SDK (public npm)
packages/cli/       @a2x/cli — CLI shipped as GitHub Release binary
samples/            Runnable integration samples (express, nextjs, …)
specification/      Canonical A2A JSON/proto specs (v0.3, v1.0)
.changeset/         Unreleased semver changesets (consumed by the bot)
```

`pnpm-workspace.yaml` scopes the workspace to `packages/*` — samples are outside it.

## Documentation sync policy (mandatory)

**Every PR that changes `packages/a2x/src/` public surface MUST update `packages/a2x/docs/` in the same PR.** Public surface means:

- New / changed / removed exports from `packages/a2x/src/index.ts` (or any subpath export declared in `packages/a2x/package.json`).
- New / changed JSON-RPC methods wired in `DefaultRequestHandler._registerRoutes()` or the `handle()` special cases.
- New / changed `A2XAgent` builder methods, constructor options, or accessors.
- New / changed `A2XClient` methods.
- New / changed error codes exposed via `A2A_ERROR_CODES`.
- Spec-conformance corrections (e.g. renaming an `A2A_METHODS` constant) even when functional behavior doesn't change.

Location map:

| What changed | Doc that must be updated |
|---|---|
| New JSON-RPC method on the server | `docs/guides/agent/streaming.md` or `docs/guides/agent/build-an-agent.md`, plus the matching client page |
| New `A2XClient` method | `docs/guides/client/*.md` |
| New security scheme | `docs/guides/advanced/authentication.md` |
| New `A2XAgentOptions` field or builder method | `docs/guides/advanced/manual-wiring.md` |
| New AgentCard capability flag / version shape | `docs/guides/advanced/agent-card-versioning.md` |
| New protocol extension | `docs/guides/advanced/extensions.md` |
| Genuinely new feature with no matching page | Add a new `.md` under `docs/guides/...` and register it in `docs/manifest.json` |

If a change genuinely has no user-visible surface (internal refactor, test-only change, dependency bump with identical behavior), state that explicitly in the PR description and skip the docs update. The default assumption is that docs move with code.

Reviewers: if a diff touches `packages/a2x/src/index.ts` or `request-handler.ts` or exports a new symbol without touching `packages/a2x/docs/`, block the merge and ask why.

### README sync

Guides under `packages/a2x/docs/` cover everything. The two READMEs are **quickstart + feature highlights** and are what every new reader sees first:

- `README.md` (repo root) — published on the GitHub repo landing page.
- `packages/a2x/README.md` — published on the npm package page.

Update them when a PR adds (or removes) something that belongs in those surfaces:

- A new top-level "Key Features" bullet (e.g. tasks/resubscribe, Claude Agent Skills runtime, authenticated extended card).
- A new top-level export path (e.g. `@a2x/sdk/client`, `@a2x/sdk/google`) — it belongs in Installation or Usage.
- A new supported LLM provider, transport, or framework integration worth advertising.
- A change to the minimum Node / pnpm version, peer-dependency requirement, or environment variable listed in the quickstart.
- Anything already listed in either README whose behavior this PR materially changes.

Don't update the READMEs for every public method — that's what guides are for. The rule of thumb: **if you would mention it in a release tweet, it belongs in the README**.

Sample READMEs under `samples/*/README.md` follow the same logic scoped to that sample.

## Changesets

A changeset is a deliberate "release now" signal. Each one bumps `@a2x/sdk` and adds an entry to the next release notes, so versions should reflect meaningful releases — not individual commits. Default to **no changeset**; add one only when this PR is itself worth cutting a release for, or it is the PR that closes out a batch the maintainer is ready to ship.

- **Add a changeset when** the change is release-worthy *and* a release should go out including this PR. Typical cases:
  - User-visible bug fix tied to a reported issue.
  - New / changed / removed public API on `@a2x/sdk`.
  - Spec-conformance correction that affects what goes on the wire.
  - Dependency / Node / peer requirement change users must know about.
  - Final PR of a batch — earlier fixes landed without changesets, and this one consolidates them into a single release entry.
- **Skip the changeset for** internal refactors with no behavior delta, test-only changes, doc-only changes under `packages/a2x/docs/` or `packages/a2x/README.md` (they ride along in the next real release), type tightening with no runtime effect, dead-code removal, or any fix that can wait until the next batched release. **When in doubt, skip** — release notes are clearer when each entry is meaningful.
- **Out of scope.** CI / repo tooling under `.github/` or lint/format configs; pure `package.json` metadata touch-ups (`author`, `keywords`, `description`); `samples/`, `specification/`, and `@a2x/cli`-only changes (CLI is in the changeset `ignore` list and ships via tag-driven GitHub Release).
- AI agents and external contributors: default to no changeset. If you believe a release should be cut for this change, note it in the PR description and let the maintainer decide.
- Version level: `patch` for fixes, `minor` for backward-compatible features, `major` for breaking changes. Pre-1.0, still follow semver.
- Do not edit `packages/a2x/CHANGELOG.md` by hand. It is regenerated by the changesets bot.

## Spec conformance

Any new or modified JSON-RPC behavior must match `specification/a2a-v0.3.0.json` and, where defined, `specification/a2a-v1.0.0.json`. When the two disagree, implement v0.3 faithfully, and treat v1.0 divergences as SDK extensions documented in the relevant guide. Constant names in `packages/a2x/src/types/jsonrpc.ts` must match the spec's `method` strings exactly.

## PR scope

Audit your domain fully before opening a PR, then bundle every related issue into that PR. Splitting cohesive work into N PRs costs N× the merge fanout (CI matrix on `main`, Release SDK, Release CLI) for the same work, and creates churn for reviewers.

Bundle:

- All known issues in one domain — all CI / repo tooling tuning, all v0.3 conformance fixes, all related refactor steps.
- Follow-ups discovered while writing the PR ("oh and that lint warning"). They belong in the same PR, not the next one.
- Tooling / workflow / config changes especially. Merge cost is high (every push to `main` fans out across CI + Release SDK + Release CLI), and most workflow behavior is decidable from the YAML — there's rarely a reason to "merge and see".

Don't bundle:

- Unrelated domains. An SDK fix, a CLI fix, and a sample fix should land as separate PRs so each can bisect / revert independently.
- Genuinely unforeseen findings discovered after merge — those are new PRs.
- Drive-by cleanup unrelated to the PR's stated purpose. ("Style: keep diffs minimal" still applies *across* domains.)

A small focused PR is correct when the audit genuinely found one thing. The discipline is **audit completeness before opening**, not making every PR big.

## Commands

From the repo root:

| Command | Purpose |
|---|---|
| `pnpm install` | Install workspace deps |
| `pnpm -r build` | Build all packages (`tsup`) |
| `pnpm test` | Run vitest across the workspace |
| `pnpm typecheck` | `tsc --noEmit` per package |
| `pnpm lint` | ESLint |
| `pnpm changeset` | Author a changeset interactively |

Before opening or updating a PR, run **test + typecheck + build + lint**. A passing suite locally is a prerequisite for CI.

## Language

All project files — source, tests, docs, changesets, commit messages, PR descriptions — are **English**, regardless of the language the request came in. Code comments stay English.

## Style

- Prefer editing existing files to creating new ones.
- No emojis in code, docs, or commit messages unless the user explicitly asked.
- Comments explain WHY, not WHAT. A good identifier already explains WHAT.
- Keep diffs minimal — no drive-by reformatting, no unrelated cleanup in a feature PR.

## Git

- Never force-push to `main` or to any branch that isn't yours.
- Never skip hooks (`--no-verify`) or bypass signing.
- Don't amend published commits. Create a new commit instead.
- Commit messages follow Conventional Commits (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`).

## Protected branches

`main` requires PR review + green CI. Admin merge (`gh pr merge --admin`) is reserved for release automation and the rare case where the PR author is the sole reviewer on a trivial change — ask before using it.
