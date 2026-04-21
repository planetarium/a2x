# Contributing to a2x

Thanks for your interest in contributing! This repo hosts the `@a2x/sdk`
package (a TypeScript SDK for the A2A protocol) and the `@a2x/cli`
command-line tool, plus runnable samples and the canonical A2A specification
mirrors.

## Before you start

Our day-to-day contribution conventions live in [`AGENTS.md`](./AGENTS.md).
That file is authoritative for both human and AI contributors — please read
it first. It covers:

- The repo layout and what lives in each workspace package.
- The **mandatory docs sync policy** for any change to the SDK public surface.
- The **README sync policy** for changes that belong in the quickstart.
- Our use of [Changesets](https://github.com/changesets/changesets) for
  versioning and release notes.
- Spec-conformance rules against `specification/a2a-v0.3.0.json` and
  `specification/a2a-v1.0.0.json`.
- Language, style, and git conventions (Conventional Commits, no
  force-pushes, no `--no-verify`).

## Quick start

```bash
git clone https://github.com/planetarium/a2x.git
cd a2x
pnpm install
```

Before opening or updating a PR, run the full local suite:

```bash
pnpm lint
pnpm typecheck
pnpm -r build
pnpm test
```

A passing local suite is a prerequisite for CI.

## Making a change

1. **Branch off `main`.** Don't work directly on `main`; use a topic branch
   (`feat/...`, `fix/...`, `docs/...`, etc.).
2. **Write a Changeset** for every source-affecting PR:
   ```bash
   pnpm changeset
   ```
   Choose `patch` for fixes, `minor` for backward-compatible features, or
   `major` for breaking changes. Pre-1.0 we still follow semver.
3. **Update the docs** when you change the SDK public surface. See the
   Documentation sync policy in `AGENTS.md` — reviewers will block merges
   that add/change exports without corresponding guide updates.
4. **Update the READMEs** for user-visible changes that belong in the
   quickstart (new top-level exports, new supported provider/framework,
   changed minimum Node version, etc.). See the README sync policy in
   `AGENTS.md`.
5. **Keep diffs minimal.** No drive-by reformatting; no unrelated cleanup in
   a feature PR.

## Opening a Pull Request

- Write your PR title as a [Conventional
  Commit](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
  `chore:`, `refactor:`, `test:`, `ci:`, `build:`).
- Fill in the PR template — it exists to catch the docs / changeset steps
  before review.
- Link any related issues (`Fixes #123`).
- Keep the PR focused on a single concern. Split otherwise.

## Reporting bugs and requesting features

Use the GitHub issue templates:

- **Bug report** — please include the package and version, a minimal repro,
  and what you observed vs. expected.
- **Feature request** — describe the motivating use case, not just the API
  shape.

For suspected security vulnerabilities, follow [`SECURITY.md`](./SECURITY.md)
instead of opening a public issue.

## Code of Conduct

This project and everyone participating in it is governed by the
[Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected
to uphold it. Report unacceptable behavior to
`conduct@planetariumhq.com`.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE).
