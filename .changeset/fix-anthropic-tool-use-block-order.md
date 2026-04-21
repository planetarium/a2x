---
"@a2x/sdk": patch
---

fix(provider/anthropic): emit tool_use blocks after text blocks in assistant messages

The Anthropic API treats a trailing tool_use block as the assistant's pending request and expects the next user message to begin with a matching tool_result. When the converter emitted tool_use before text inside the same assistant message, Anthropic rejected the conversation with `tool_use ids were found without tool_result blocks immediately after`, breaking any tool-calling flow where the model produced preamble text alongside a tool call.
