import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillLoader } from '../skills/loader.js';
import { createRunSkillScriptTool } from '../skills/run-skill-script-tool.js';
import { defineSkill } from '../skills/define-skill.js';
import type { InvocationContext } from '../runner/context.js';
import type { SkillScriptExecutionMeta } from '../skills/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALID_FULL = path.join(__dirname, 'fixtures/skills/valid-full');

function buildContext(sessionId = 'sid'): InvocationContext {
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

describe('Layer 2: run_skill_script tool', () => {
  it('allow mode executes a hello.sh script and returns stdout', async () => {
    const { registry } = await SkillLoader.load({ root: VALID_FULL });
    const tool = createRunSkillScriptTool(registry);
    const res = (await tool.execute(
      { skill: 'valid-full', script: 'scripts/hello.sh', arguments: ['world'] },
      buildContext(),
    )) as { stdout: string; exitCode: number };
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('hello world');
  });

  it('rejects script paths that escape the skill directory', async () => {
    const { registry } = await SkillLoader.load({ root: VALID_FULL });
    const tool = createRunSkillScriptTool(registry);
    const res = (await tool.execute(
      { skill: 'valid-full', script: 'scripts/../../../etc/hosts' },
      buildContext(),
    )) as { error: string };
    expect(res.error).toMatch(/invalid|escape/);
  });

  it('rejects scripts outside scripts/', async () => {
    const { registry } = await SkillLoader.load({ root: VALID_FULL });
    const tool = createRunSkillScriptTool(registry);
    const res = (await tool.execute(
      { skill: 'valid-full', script: 'FORMS.md' },
      buildContext(),
    )) as { error: string };
    expect(res.error).toContain('scripts/');
  });

  it('deny mode blocks execution and still calls the audit hook', async () => {
    const hookCalls: SkillScriptExecutionMeta[] = [];
    const { registry } = await SkillLoader.load({
      root: VALID_FULL,
      scriptMode: 'deny',
      onScriptExecute: (meta) => {
        hookCalls.push(meta);
        return true;
      },
    });
    const tool = createRunSkillScriptTool(registry);
    const res = (await tool.execute(
      { skill: 'valid-full', script: 'scripts/hello.sh' },
      buildContext(),
    )) as { error: string };
    expect(res.error).toContain('disabled');
    expect(hookCalls.length).toBe(1);
    expect(hookCalls[0].mode).toBe('deny');
  });

  it('confirm mode: false hook blocks execution', async () => {
    const { registry } = await SkillLoader.load({
      root: VALID_FULL,
      scriptMode: 'confirm',
      onScriptExecute: () => false,
    });
    const tool = createRunSkillScriptTool(registry);
    const res = (await tool.execute(
      { skill: 'valid-full', script: 'scripts/hello.sh' },
      buildContext(),
    )) as { error: string };
    expect(res.error).toContain('rejected');
  });

  it('confirm mode: true hook permits execution', async () => {
    const { registry } = await SkillLoader.load({
      root: VALID_FULL,
      scriptMode: 'confirm',
      onScriptExecute: () => true,
    });
    const tool = createRunSkillScriptTool(registry);
    const res = (await tool.execute(
      { skill: 'valid-full', script: 'scripts/hello.sh', arguments: ['x'] },
      buildContext(),
    )) as { stdout: string; exitCode: number };
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('hello x');
  });

  it('onScriptExecute throw aborts execution even in allow mode (NFR-021)', async () => {
    const { registry } = await SkillLoader.load({
      root: VALID_FULL,
      scriptMode: 'allow',
      onScriptExecute: () => {
        throw new Error('boom');
      },
    });
    const tool = createRunSkillScriptTool(registry);
    const res = (await tool.execute(
      { skill: 'valid-full', script: 'scripts/hello.sh' },
      buildContext(),
    )) as { error: string };
    expect(res.error).toContain('boom');
  });

  it('audit hook observes skill/script metadata', async () => {
    const hooks: SkillScriptExecutionMeta[] = [];
    const { registry } = await SkillLoader.load({
      root: VALID_FULL,
      scriptMode: 'allow',
      onScriptExecute: (meta) => {
        hooks.push(meta);
        return true;
      },
    });
    const tool = createRunSkillScriptTool(registry);
    await tool.execute(
      { skill: 'valid-full', script: 'scripts/hello.sh', arguments: ['a'] },
      buildContext('sess-audit'),
    );
    expect(hooks.length).toBe(1);
    expect(hooks[0].skillName).toBe('valid-full');
    expect(hooks[0].scriptRelativePath).toBe('scripts/hello.sh');
    expect(hooks[0].sessionId).toBe('sess-audit');
    expect(hooks[0].agentName).toBe('test-agent');
    expect(hooks[0].mode).toBe('allow');
  });

  it('inline script handler runs in-process and returns stdout', async () => {
    let handlerCalls = 0;
    const inline = defineSkill({
      name: 'inline-script',
      description: 'inline with a functional script',
      body: '',
      scripts: {
        'scripts/run.js': async ({ arguments: argv }) => {
          handlerCalls++;
          return {
            stdout: `inline:${argv.join(',')}`,
            exitCode: 0,
          };
        },
      },
    });
    const { registry } = await SkillLoader.load({ inline: [inline] });
    const tool = createRunSkillScriptTool(registry);
    const res = (await tool.execute(
      { skill: 'inline-script', script: 'scripts/run.js', arguments: ['x', 'y'] },
      buildContext(),
    )) as { stdout: string; exitCode: number };
    expect(handlerCalls).toBe(1);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('inline:x,y');
  });

  it('inline skill without an inline handler falls back to an error', async () => {
    const inline = defineSkill({
      name: 'inline-nohandler',
      description: 'inline with a resource-backed script',
      body: '',
      scripts: {
        'scripts/run.sh': '#!/usr/bin/env bash\necho hi\n',
      },
    });
    const { registry } = await SkillLoader.load({ inline: [inline] });
    const tool = createRunSkillScriptTool(registry);
    const res = (await tool.execute(
      { skill: 'inline-nohandler', script: 'scripts/run.sh' },
      buildContext(),
    )) as { error: string };
    expect(res.error).toContain('not executable');
  });
});
