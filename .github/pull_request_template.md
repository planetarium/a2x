<!--
Thanks for the PR! Keep the title as a Conventional Commit
(feat:, fix:, docs:, chore:, refactor:, test:, ci:, build:).
-->

## Summary

<!-- One or two sentences on what this PR changes and why. Link issues with "Fixes #123". -->

## Changes

<!-- Bullet list of user-visible behavior changes. -->

-

## Docs sync (required if you change the SDK public surface)

See `AGENTS.md` "Documentation sync policy" and "README sync".

- [ ] No SDK public surface changed (internal refactor / test-only / identical-behavior dep bump). Explain briefly: <!-- ... -->
- [ ] Updated `packages/a2x/docs/guides/...` for every new/changed/removed export, JSON-RPC method, builder method, client method, or error code.
- [ ] Updated `docs/manifest.json` if a new guide page was added.
- [ ] Updated the root `README.md` and/or `packages/a2x/README.md` if this change belongs in a quickstart or "Key Features" bullet.
- [ ] Updated `samples/*/README.md` if a sample's behavior changed.

## Changeset

- [ ] Added a `.changeset/*.md` entry (`patch` / `minor` / `major`).
- [ ] Not needed — pure non-source change (e.g. workflow or sample-only edit). Explain briefly: <!-- ... -->

## Spec conformance (if JSON-RPC behavior changed)

- [ ] Matches `specification/a2a-v0.3.0.json` (required).
- [ ] Matches `specification/a2a-v1.0.0.json` where defined, or divergences are documented as SDK extensions in a guide.
- [ ] `A2A_METHODS` constant names still match spec `method` strings exactly.

## Local checks

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm -r build`
- [ ] `pnpm test`

## Notes for reviewers

<!-- Call out anything that needs extra attention: tricky edge cases, deliberate scope cuts, follow-up PRs. -->
