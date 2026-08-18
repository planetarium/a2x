---
"@a2x/sdk": patch
---

Emit the first streamed text artifact chunk with `append: false`.

Later text chunks continue with `append: true`, and the final consolidated artifact still replaces the accumulated value. This gives strict A2A clients a base artifact before any append update, including streams that end in failure or an input request.
