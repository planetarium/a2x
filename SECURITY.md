# Security Policy

## Supported Versions

We currently ship `@a2x/sdk` and `@a2x/cli` pre-1.0. Only the latest minor
release on the `main` branch receives security fixes. Once we cut a 1.x line,
this table will be updated accordingly.

| Package      | Supported              |
| ------------ | ---------------------- |
| `@a2x/sdk`   | latest 0.x release     |
| `@a2x/cli`   | latest 0.x release     |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report suspected vulnerabilities using one of the following channels:

1. **GitHub Security Advisories (preferred)** — open a private advisory at
   <https://github.com/planetarium/a2x/security/advisories/new>.
2. **Email** — send a description to `security@planetariumhq.com` with the
   subject line `[a2x] <short summary>`.

Please include:

- The package and version (`@a2x/sdk@x.y.z` or `@a2x/cli@x.y.z`).
- A minimal reproduction or proof-of-concept, if possible.
- The impact you believe the issue has (confidentiality, integrity,
  availability) and any known mitigations.
- Whether the vulnerability has already been disclosed anywhere.

## Our Commitment

- We will acknowledge receipt within **3 business days**.
- We will provide an initial assessment and a target remediation window within
  **10 business days** of acknowledgement.
- We will coordinate a disclosure timeline with you and credit you in the
  advisory unless you ask to remain anonymous.

## Scope

In scope:

- Code in `packages/a2x/` (`@a2x/sdk`) and `packages/cli/` (`@a2x/cli`).
- Published release artifacts on npm and GitHub Releases under
  `planetarium/a2x`.
- OAuth 2.0 Device Flow handling in the SDK and CLI auth provider.

Out of scope:

- Vulnerabilities in sample applications under `samples/` (these are
  illustrative only; please still tell us, but they are not treated as
  production security issues).
- Vulnerabilities solely in upstream dependencies — please report those to the
  upstream maintainers. If a safe upgrade path needs to land here, feel free
  to open a regular PR.
- Issues requiring physical access to a developer's machine, or that depend on
  the user running untrusted binaries outside of a verified release.
