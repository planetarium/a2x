---
"@a2x/sdk": minor
---

feat(skills): integrate Claude Agent Skills open standard runtime

Adds optional `skills` support to `LlmAgent` so any agent can load an
open Claude Agent Skills directory (SKILL.md frontmatter + body + bundled
files + scripts) or inline skills via `defineSkill()`. On activation the
SDK registers three provider-agnostic builtin tools — `load_skill`,
`read_skill_file`, `run_skill_script` — and injects the skill metadata
block into the system prompt so Anthropic, OpenAI, and Google providers
observe identical behaviour (progressive disclosure: eager metadata,
lazy body, lazy references). Script execution is policy-aware
(`allow` / `confirm` / `deny`) and audit-hook aware via
`onScriptExecute`. Zero new runtime dependencies: a minimal YAML
frontmatter parser is included. Existing agents are unaffected when the
`skills` option is absent.
