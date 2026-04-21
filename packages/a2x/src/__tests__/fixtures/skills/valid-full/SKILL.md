---
name: valid-full
description: A skill exercising every frontmatter feature the SDK supports.
when_to_use: For tests that verify advanced parser behaviour.
allowed-tools:
  - Bash
  - Read
argument-hint: "[target]"
shell: bash
# Claude Code-only fields — the parser must preserve these as unknownFields.
disable-model-invocation: false
user-invocable: true
model: claude-sonnet
---

# valid-full

This skill references [FORMS](FORMS.md) and also mentions `REFERENCE.md`
in plain text. The substitution engine can insert ${A2X_SKILL_DIR}
here at runtime.

Run scripts via `run_skill_script`; for example `scripts/hello.sh`.
