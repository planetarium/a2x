---
"@a2x/sdk": minor
---

Servers now read the A2A v1.0 `A2A-Version` header (spec a2a-v1.0 §3.2.6 / §9.2). The pinned version is matched on `Major.Minor` per spec (`0.3.0` pins the same version as `0.3`); a pin that doesn't match the server's `protocolVersion` is rejected with the new `VersionNotSupportedError` (`-32009`, exported and added to `A2A_ERROR_CODES` as `VERSION_NOT_SUPPORTED`). Requests without the header keep being served in the server's configured version. (#193)
