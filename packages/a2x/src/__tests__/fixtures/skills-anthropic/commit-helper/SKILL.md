---
name: commit-helper
description: Generate commit messages from staged changes. Use when the user asks to commit changes or when preparing a pull request body.
when_to_use: For commits or PR summaries.
allowed-tools: Bash(git *) Bash(ls *)
argument-hint: "[ticket-id]"
---

# commit-helper

1. Run `git status` and `git diff --staged` to read the changes.
2. Summarise the changes and produce a conventional-commit message.
