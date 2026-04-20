---
"@a2x/sdk": minor
---

Bundle a Guides directory (`docs/`) with the npm package. The new tree under
`node_modules/@a2x/sdk/docs/` contains progressive-disclosure guides (Getting
Started → Agent → Client → Advanced) plus a `manifest.json` describing the
navigation. The `a2x-web` documentation site consumes these files at build
time so guides stay version-locked to the SDK that introduced them.

No API surface change; this release only enlarges the published tarball.
