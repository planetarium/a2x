---
'@a2x/sdk': patch
---

Keep streaming subscribers attached when a custom executor emits an intermediate input-required or auth-required status with `final: false`. Allow the same execution to resume and deliver subsequent artifacts and completion; finalize an interrupted status only when the executor ends or explicitly marks the interaction final.
