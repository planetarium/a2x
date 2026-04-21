import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOAD_SKILL_TOOL_NAME,
  READ_SKILL_FILE_TOOL_NAME,
  RUN_SKILL_SCRIPT_TOOL_NAME,
  createLoadSkillTool,
} from '../skills/load-skill-tool.js';
import { createReadSkillFileTool } from '../skills/read-skill-file-tool.js';
import { SkillLoader } from '../skills/loader.js';
import { combineSystemInstruction, formatSystemPromptBlock } from '../skills/prompt.js';
import type { InvocationContext } from '../runner/context.js';
import { LlmAgent } from '../agent/llm-agent.js';
import { BaseLlmProvider } from '../provider/base.js';
import { FunctionTool } from '../tool/function-tool.js';
import { defineSkill } from '../skills/define-skill.js';
import { SkillConfigError } from '../skills/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALID_FULL = path.join(__dirname, 'fixtures/skills/valid-full');
const VALID_SIMPLE = path.join(__dirname, 'fixtures/skills/valid-simple');

class MockProvider extends BaseLlmProvider {
  readonly name = 'mock';
  constructor() { super({ model: 'mock' }); }
  async generateContent() {
    return { content: [], finishReason: 'stop' };
  }
}

function buildContext(sessionId = 's1'): InvocationContext {
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
    agentName: 'test-agent',
  };
}

describe('Layer 2: load_skill tool', () => {
  it('produces a ToolDeclaration with the expected name/schema', async () => {
    const { registry } = await SkillLoader.load({ root: VALID_FULL });
    const tool = createLoadSkillTool(registry);
    expect(tool.name).toBe(LOAD_SKILL_TOOL_NAME);
    const params = tool.getParameterSchema() as { required?: string[]; type?: string };
    expect(params.type).toBe('object');
    expect(params.required).toEqual(['name']);
  });

  it('returns the body with substitutions applied', async () => {
    const { registry } = await SkillLoader.load({ root: VALID_FULL });
    const tool = createLoadSkillTool(registry);
    const ctx = buildContext('sess-xyz');
    const result = (await tool.execute({ name: 'valid-full' }, ctx)) as {
      skill_name: string;
      skill_dir: string;
      body: string;
      referenced_files: readonly string[];
    };
    expect(result.skill_name).toBe('valid-full');
    expect(result.body).toContain(VALID_FULL);
    expect(result.referenced_files).toContain('FORMS.md');
  });

  it('returns an error shape for unknown skills', async () => {
    const { registry } = await SkillLoader.load({ root: VALID_SIMPLE });
    const tool = createLoadSkillTool(registry);
    const res = (await tool.execute({ name: 'does-not-exist' }, buildContext())) as {
      error: string;
    };
    expect(res.error).toContain('does-not-exist');
  });

  it('repeated calls for the same skill return equivalent substituted bodies', async () => {
    const { registry } = await SkillLoader.load({ root: VALID_FULL });
    const tool = createLoadSkillTool(registry);
    const ctx = buildContext('sess-same');
    const a = await tool.execute({ name: 'valid-full' }, ctx);
    const b = await tool.execute({ name: 'valid-full' }, ctx);
    expect(a).toEqual(b);
  });
});

describe('Layer 2: read_skill_file tool', () => {
  it('rejects path escapes', async () => {
    const { registry } = await SkillLoader.load({ root: VALID_FULL });
    const tool = createReadSkillFileTool(registry);
    const res = (await tool.execute(
      { skill: 'valid-full', file: '../../etc/passwd' },
      buildContext(),
    )) as { error: string };
    expect(res.error).toContain('not accessible');
  });

  it('rejects absolute paths', async () => {
    const { registry } = await SkillLoader.load({ root: VALID_FULL });
    const tool = createReadSkillFileTool(registry);
    const res = (await tool.execute(
      { skill: 'valid-full', file: '/etc/passwd' },
      buildContext(),
    )) as { error: string };
    expect(res.error).toContain('not accessible');
  });

  it('reads a bundled file and substitutes variables in its content', async () => {
    const { registry } = await SkillLoader.load({ root: VALID_FULL });
    const tool = createReadSkillFileTool(registry);
    const res = (await tool.execute(
      { skill: 'valid-full', file: 'FORMS.md' },
      buildContext('sess-read'),
    )) as { content: string; encoding: string };
    expect(res.encoding).toBe('utf8');
    expect(res.content).toContain('Session id: sess-read');
  });
});

describe('Layer 2: system prompt block', () => {
  it('formatSystemPromptBlock builds expected XML-style block', async () => {
    const { registry } = await SkillLoader.load({ root: VALID_FULL });
    const block = formatSystemPromptBlock(registry);
    expect(block).toContain('# Available Agent Skills');
    expect(block).toContain('<skill name="valid-full">');
  });

  it('combineSystemInstruction appends block after the base instruction', async () => {
    const { registry } = await SkillLoader.load({ root: VALID_SIMPLE });
    const combined = combineSystemInstruction('You are a helpful agent.', registry);
    expect(combined.startsWith('You are a helpful agent.')).toBe(true);
    expect(combined).toContain('<skill name="valid-simple">');
  });
});

describe('Layer 2: LlmAgent + skills integration', () => {
  it('adds load_skill and read_skill_file as tool declarations', async () => {
    const agent = new LlmAgent({
      name: 'agent-a',
      provider: new MockProvider(),
      instruction: 'You are a test agent.',
      skills: { root: VALID_SIMPLE },
    });
    const registry = await agent.whenSkillsReady();
    expect(registry).not.toBeNull();
    expect(registry!.size).toBe(1);
  });

  it('rejects tools that collide with reserved skill tool names', () => {
    expect(() => new LlmAgent({
      name: 'bad-agent',
      provider: new MockProvider(),
      instruction: 'x',
      tools: [new FunctionTool({
        name: LOAD_SKILL_TOOL_NAME,
        description: 'custom',
        parameters: { type: 'object' },
        execute: async () => 'ok',
      })],
      skills: { root: VALID_SIMPLE },
    })).toThrow(SkillConfigError);
    expect(() => new LlmAgent({
      name: 'bad-agent2',
      provider: new MockProvider(),
      instruction: 'x',
      tools: [new FunctionTool({
        name: READ_SKILL_FILE_TOOL_NAME,
        description: 'custom',
        parameters: { type: 'object' },
        execute: async () => 'ok',
      })],
      skills: { root: VALID_SIMPLE },
    })).toThrow(SkillConfigError);
    expect(() => new LlmAgent({
      name: 'bad-agent3',
      provider: new MockProvider(),
      instruction: 'x',
      tools: [new FunctionTool({
        name: RUN_SKILL_SCRIPT_TOOL_NAME,
        description: 'custom',
        parameters: { type: 'object' },
        execute: async () => 'ok',
      })],
      skills: { root: VALID_SIMPLE },
    })).toThrow(SkillConfigError);
  });

  it('beforeModelCallback observes the skill metadata block in systemInstruction', async () => {
    // Provider that records the systemInstruction it receives and triggers a
    // load_skill tool call on the first invocation so we can assert the
    // result flow as well.
    const received: { systemInstruction?: string; tools?: unknown[] }[] = [];
    let callCount = 0;
    class RecordingProvider extends BaseLlmProvider {
      readonly name = 'rec';
      constructor() { super({ model: 'rec' }); }
      async generateContent(req: Parameters<BaseLlmProvider['generateContent']>[0]) {
        callCount++;
        received.push({
          systemInstruction: req.systemInstruction,
          tools: req.tools,
        });
        if (callCount === 1) {
          return {
            content: [],
            toolCalls: [{ id: '1', name: 'load_skill', args: { name: 'valid-simple' } }],
            finishReason: 'tool_use',
          };
        }
        return { content: [{ text: 'done' }], finishReason: 'stop' };
      }
    }
    const agent = new LlmAgent({
      name: 'agent-b',
      provider: new RecordingProvider(),
      instruction: 'You are a test agent.',
      skills: { root: VALID_SIMPLE },
    });
    const events: unknown[] = [];
    for await (const ev of agent.run(buildContext('sess-int'))) {
      events.push(ev);
    }
    expect(received[0].systemInstruction).toContain('<skill name="valid-simple">');
    const toolNames = (received[0].tools ?? []).map((t) => (t as { name: string }).name);
    expect(toolNames).toContain('load_skill');
    expect(toolNames).toContain('read_skill_file');
    expect(toolNames).toContain('run_skill_script');
    // toolResult event must include the body text from the skill
    const toolResult = events.find(
      (e): e is { type: 'toolResult'; result: { body: string } } =>
        (e as { type?: string }).type === 'toolResult',
    );
    expect(toolResult).toBeDefined();
    expect((toolResult as { result: { body: string } }).result.body).toContain('valid-simple');
  });

  it('skills undefined leaves existing tool list unmodified', async () => {
    const agent = new LlmAgent({
      name: 'no-skills',
      provider: new MockProvider(),
      instruction: 'test',
    });
    expect(await agent.whenSkillsReady()).toBeNull();
    expect(agent.tools).toEqual([]);
  });

  it('inline skill is registered and loadable', async () => {
    const inlineSkill = defineSkill({
      name: 'inline-demo',
      description: 'an inline skill',
      body: '# hello from inline\nsid=${A2X_SESSION_ID}',
    });
    const agent = new LlmAgent({
      name: 'inline-agent',
      provider: new MockProvider(),
      instruction: 'x',
      skills: { inline: [inlineSkill] },
    });
    const registry = await agent.whenSkillsReady();
    expect(registry!.get('inline-demo')).toBeDefined();
  });
});
