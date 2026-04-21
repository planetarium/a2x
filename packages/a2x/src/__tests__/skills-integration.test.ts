import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmAgent } from '../agent/llm-agent.js';
import { BaseLlmProvider } from '../provider/base.js';
import type { InvocationContext } from '../runner/context.js';
import type { LlmRequest, LlmResponse } from '../agent/llm-provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALID_FULL = path.join(__dirname, 'fixtures/skills/valid-full');

function buildContext(sessionId = 'sess-int'): InvocationContext {
  return {
    session: {
      id: sessionId,
      appName: 'test',
      state: {},
      events: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    state: {},
    agentName: 'agent',
  };
}

/**
 * A provider that mimics the shape of each concrete provider. The SDK
 * converts provider-neutral `LlmRequest` / `LlmResponse` into/from each
 * provider's native transport, so as long as the request hitting our mock is
 * identical across providers, the LLM-observable behaviour is guaranteed to
 * be identical too.
 */
class MockProvider extends BaseLlmProvider {
  readonly calls: LlmRequest[] = [];
  constructor(readonly name: string) {
    super({ model: 'mock' });
  }
  async generateContent(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    if (this.calls.length === 1) {
      return {
        content: [],
        toolCalls: [{ id: '1', name: 'load_skill', args: { name: 'valid-full', arguments: 'alpha' } }],
        finishReason: 'tool_use',
      };
    }
    return { content: [{ text: 'done' }], finishReason: 'stop' };
  }
}

describe('Layer 2: 3-provider homogeneity (NFR-052 / AC-2)', () => {
  it('all three provider stand-ins receive identical systemInstruction + tool declarations', async () => {
    const providers = ['anthropic', 'openai', 'google'].map((n) => new MockProvider(n));
    const agents = providers.map((p) => new LlmAgent({
      name: `agent-${p.name}`,
      provider: p,
      instruction: 'You are a test agent.',
      skills: { root: VALID_FULL },
    }));

    // Run each agent and collect the first request the mock saw.
    for (const agent of agents) {
      for await (const _ of agent.run(buildContext())) {
        /* drain events */
      }
    }

    // Step 1 — systemInstruction identical across providers.
    const sys = providers.map((p) => p.calls[0].systemInstruction);
    expect(sys[0]).toBeDefined();
    expect(sys[0]).toBe(sys[1]);
    expect(sys[1]).toBe(sys[2]);

    // Step 2 — tool declarations identical.
    const tools = providers.map((p) => p.calls[0].tools);
    for (const t of tools) expect(t?.map((x) => x.name).sort()).toEqual(['load_skill', 'read_skill_file', 'run_skill_script']);
    expect(JSON.stringify(tools[0])).toBe(JSON.stringify(tools[1]));
    expect(JSON.stringify(tools[1])).toBe(JSON.stringify(tools[2]));

    // Step 3 — second-call contents include an equal tool result per provider.
    const secondCall = providers.map((p) => p.calls[1]);
    for (const c of secondCall) expect(c).toBeDefined();
    // Each second-call contents[last].metadata.toolResults[0].result includes the body text.
    for (const c of secondCall) {
      const last = c.contents[c.contents.length - 1];
      const results = (last.metadata as { toolResults?: { result: unknown }[] } | undefined)?.toolResults;
      expect(results).toBeDefined();
      const result = results![0].result as { body: string };
      expect(result.body).toContain('valid-full');
    }
  });
});
