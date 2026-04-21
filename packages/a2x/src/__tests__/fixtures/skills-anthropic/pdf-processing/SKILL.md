---
name: pdf-processing
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash(python *)
argument-hint: "[filename] [format]"
when_to_use: Forms, document extraction, PDF manipulation
model: claude-opus-4-7
effort: max
context: fork
agent: Explore
paths: "**/*.pdf,**/*.form"
shell: bash
---

# pdf-processing

Use the bundled script `scripts/analyze_form.py` to process a PDF form
located at `${A2X_SKILL_DIR}/examples/input.pdf`.
