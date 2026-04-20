# What is A2X?

A2X is a TypeScript SDK for building and consuming [A2A (Agent-to-Agent)](https://a2a-protocol.org/) protocol agents. It lets you expose any LLM-backed workflow as a standards-compliant endpoint other agents and clients can discover, call, and stream from.

## Mental model

An A2A agent is an HTTP service with two surfaces:

- `GET /.well-known/agent.json` — a discoverable **AgentCard** that describes what the agent can do, how to authenticate, and how to reach it.
- `POST /a2a` — a JSON-RPC endpoint that accepts `message/send`, `message/stream`, `tasks/get`, and `tasks/cancel`.

A2X gives you two things:

1. **Server-side ergonomics** — define your agent in plain TypeScript, plug in an LLM provider, and A2X emits a correct AgentCard and wires up the JSON-RPC handler for you.
2. **Client-side ergonomics** — `A2XClient` calls any A2A-compliant agent (not just A2X ones) with a typed, Promise/AsyncIterator surface.

## When to reach for A2X

- You want to expose an LLM workflow as an A2A endpoint without hand-authoring AgentCards.
- You want to compose agents (delegation, pipelines, parallel fan-out, iterative refinement).
- You want to call third-party A2A agents from TypeScript code with type safety.
- You want to stay framework-agnostic — A2X plugs into Express, Fastify, Hono, Next.js, or any Node.js HTTP stack.

## When A2X is overkill

- You're calling a single LLM once and don't need discovery, streaming, or multi-agent composition. Use the provider SDK directly.
- You need a UI framework — A2X is a protocol layer, not a frontend.

## What's next

- [Quickstart](./quickstart.md) — your first agent in under 30 lines of code.
- [Agent guides](./agent/build-an-agent.md) — the primary path for building agents.
- [Client guides](./client/basics.md) — consuming remote A2A agents.
