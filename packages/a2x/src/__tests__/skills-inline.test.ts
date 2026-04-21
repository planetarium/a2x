import { describe, it, expect } from 'vitest';
import { defineSkill } from '../skills/define-skill.js';
import { SkillConfigError } from '../skills/errors.js';
import { SkillLoader } from '../skills/loader.js';
import { createLoadSkillTool } from '../skills/load-skill-tool.js';
import { createReadSkillFileTool } from '../skills/read-skill-file-tool.js';
import type { InvocationContext } from '../runner/context.js';

function buildContext(sessionId = 'sess-inline'): InvocationContext {
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

describe('Layer 2: defineSkill + inline runtime', () => {
  it('rejects missing required fields', () => {
    expect(() => defineSkill({ name: '', description: 'x', body: '' })).toThrow(SkillConfigError);
    expect(() => defineSkill({ name: 'ok', description: '', body: '' })).toThrow(SkillConfigError);
    expect(() => defineSkill({ name: 'ok', description: 'd', body: null as unknown as string })).toThrow(SkillConfigError);
  });

  it('rejects reserved names', () => {
    expect(() => defineSkill({ name: 'claude', description: 'd', body: '' })).toThrow(SkillConfigError);
    expect(() => defineSkill({ name: 'anthropic', description: 'd', body: '' })).toThrow(SkillConfigError);
  });

  it('rejects invalid name formats', () => {
    expect(() => defineSkill({ name: 'Foo', description: 'd', body: '' })).toThrow(SkillConfigError);
    expect(() => defineSkill({ name: 'x'.repeat(65), description: 'd', body: '' })).toThrow(SkillConfigError);
  });

  it('rejects resources/scripts with .. segments', () => {
    expect(() => defineSkill({
      name: 'ok',
      description: 'd',
      body: '',
      resources: { '../foo': 'x' },
    })).toThrow(SkillConfigError);
    expect(() => defineSkill({
      name: 'ok',
      description: 'd',
      body: '',
      scripts: { '../run.sh': 'x' },
    })).toThrow(SkillConfigError);
  });

  it('rejects script keys not under scripts/', () => {
    expect(() => defineSkill({
      name: 'ok',
      description: 'd',
      body: '',
      scripts: { 'run.sh': 'x' },
    })).toThrow(SkillConfigError);
  });

  it('inline skill and file skill produce structurally equivalent load_skill output shape', async () => {
    const inline = defineSkill({
      name: 'shape-check',
      description: 'inline vs file equality test',
      body: '# hi ${A2X_SESSION_ID}',
      resources: { 'NOTES.md': 'notes' },
    });
    const { registry } = await SkillLoader.load({ inline: [inline] });
    const tool = createLoadSkillTool(registry);
    const res = (await tool.execute(
      { name: 'shape-check' },
      buildContext('s1'),
    )) as Record<string, unknown>;
    // Same keys as file-backed result:
    expect(Object.keys(res).sort()).toEqual([
      'allowed_tools_hint',
      'body',
      'referenced_files',
      'skill_dir',
      'skill_name',
    ]);
    expect(res.body).toBe('# hi s1');
    expect(res.skill_dir).toBe('inline:shape-check');
    expect(res.referenced_files).toEqual(['NOTES.md']);
  });

  it('read_skill_file returns inline resources', async () => {
    const inline = defineSkill({
      name: 'inline-read',
      description: 'resource reader',
      body: '',
      resources: { 'FORMS.md': 'form content sid=${A2X_SESSION_ID}' },
    });
    const { registry } = await SkillLoader.load({ inline: [inline] });
    const tool = createReadSkillFileTool(registry);
    const res = (await tool.execute(
      { skill: 'inline-read', file: 'FORMS.md' },
      buildContext('xyz'),
    )) as { content: string; encoding: string };
    expect(res.encoding).toBe('utf8');
    expect(res.content).toBe('form content sid=xyz');
  });

  it('read_skill_file returns base64 for binary inline resources', async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const inline = defineSkill({
      name: 'inline-binary',
      description: 'binary reader',
      body: '',
      resources: { 'payload.bin': bytes },
    });
    const { registry } = await SkillLoader.load({ inline: [inline] });
    const tool = createReadSkillFileTool(registry);
    const res = (await tool.execute(
      { skill: 'inline-binary', file: 'payload.bin' },
      buildContext(),
    )) as { content: string; encoding: string };
    expect(res.encoding).toBe('base64');
    expect(Buffer.from(res.content, 'base64').equals(bytes)).toBe(true);
  });
});
