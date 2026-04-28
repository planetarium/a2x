---
'@a2x/sdk': patch
---

`isFilePart()` now recognizes the v0.3 spec FilePart wire shape in addition
to the SDK's flat internal shape.

Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 4 of 5).

**Why.** v0.3 `FilePart` (`a2a-v0.3.0.json:828`) is nested:
`{ kind: 'file', file: { bytes | uri, mimeType?, name? } }`. The pre-fix
guard only matched the SDK's internal flat shape (`{ raw }` / `{ url }`),
so a spec-conformant FilePart coming off the wire fell through every part
type guard and was silently classified as none. The v0.3 response mapper
output already produced the nested shape correctly — only input
classification was asymmetric.

**Fix.** The guard now also returns `true` for `{ kind: 'file', file: { ... } }`.
`isTextPart` and `isDataPart` already handled their respective shapes
correctly and are unchanged.
