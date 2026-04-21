import { describe, it, expect } from 'vitest';
import { parseSkillFile } from '../skills/parser.js';
import { SkillParseError } from '../skills/errors.js';
import { parseYaml, YamlParseError } from '../skills/yaml.js';

describe('Layer 2: Skills parser', () => {
  describe('parseYaml (internal)', () => {
    it('parses flat scalar fields', () => {
      const out = parseYaml('name: foo\ndescription: "hello world"\nshell: bash\n');
      expect(out).toEqual({ name: 'foo', description: 'hello world', shell: 'bash' });
    });

    it('parses block lists', () => {
      const out = parseYaml('allowed-tools:\n  - Bash\n  - Read\n');
      expect(out).toEqual({ 'allowed-tools': ['Bash', 'Read'] });
    });

    it('parses flow lists', () => {
      const out = parseYaml('allowed-tools: [Bash, "Read", Grep]\n');
      expect(out).toEqual({ 'allowed-tools': ['Bash', 'Read', 'Grep'] });
    });

    it('parses booleans and null', () => {
      const out = parseYaml('disable-model-invocation: false\nuser-invocable: true\nmodel: null\n');
      expect(out).toEqual({
        'disable-model-invocation': false,
        'user-invocable': true,
        model: null,
      });
    });

    it('handles # comments', () => {
      const out = parseYaml('name: foo # the skill name\n# a comment line\ndescription: bar\n');
      expect(out).toEqual({ name: 'foo', description: 'bar' });
    });

    it('throws on nested mapping', () => {
      expect(() => parseYaml('foo:\n  bar: baz\n')).toThrow(YamlParseError);
    });

    it('throws on unterminated quoted string', () => {
      expect(() => parseYaml('name: "oops\n')).toThrow(YamlParseError);
    });

    it('supports escaped characters in double-quoted strings', () => {
      const out = parseYaml('description: "line1\\nline2"\n');
      expect(out).toEqual({ description: 'line1\nline2' });
    });
  });

  describe('parseSkillFile', () => {
    it('parses a minimal SKILL.md', () => {
      const raw = '---\nname: foo\ndescription: bar\n---\n# body\n';
      const res = parseSkillFile(raw, 'test');
      expect(res.metadata.name).toBe('foo');
      expect(res.metadata.description).toBe('bar');
      expect(res.body).toBe('# body\n');
      expect(res.warnings).toEqual([]);
    });

    it('rejects SKILL.md without frontmatter', () => {
      expect(() => parseSkillFile('# body only\n', 'test')).toThrow(SkillParseError);
    });

    it('rejects SKILL.md with unterminated frontmatter', () => {
      expect(() => parseSkillFile('---\nname: foo\n', 'test')).toThrow(SkillParseError);
    });

    it('rejects when name is missing', () => {
      expect(() => parseSkillFile('---\ndescription: bar\n---\n', 'test')).toThrow(/name/);
    });

    it('rejects when description is missing', () => {
      expect(() => parseSkillFile('---\nname: foo\n---\n', 'test')).toThrow(/description/);
    });

    it('rejects name with uppercase letters', () => {
      expect(() => parseSkillFile('---\nname: Foo\ndescription: d\n---\n', 'test')).toThrow(/name/);
    });

    it('rejects name with spaces', () => {
      expect(() => parseSkillFile('---\nname: "foo bar"\ndescription: d\n---\n', 'test')).toThrow(/name/);
    });

    it('rejects reserved names (anthropic)', () => {
      expect(() => parseSkillFile('---\nname: anthropic\ndescription: d\n---\n', 'test')).toThrow(/reserved/);
    });

    it('rejects reserved names (claude)', () => {
      expect(() => parseSkillFile('---\nname: claude\ndescription: d\n---\n', 'test')).toThrow(/reserved/);
    });

    it('accepts a full SKILL.md with when_to_use and allowed-tools array', () => {
      const raw = [
        '---',
        'name: valid-full',
        'description: d',
        'when_to_use: extras',
        'allowed-tools:',
        '  - Bash',
        '  - Read',
        'argument-hint: "[x]"',
        'shell: bash',
        '---',
        'body',
      ].join('\n') + '\n';
      const res = parseSkillFile(raw, 'test');
      expect(res.metadata.whenToUse).toBe('extras');
      expect(res.metadata.allowedTools).toEqual(['Bash', 'Read']);
      expect(res.metadata.argumentHint).toBe('[x]');
      expect(res.metadata.shell).toBe('bash');
    });

    it('supports allowed-tools as a whitespace-separated string', () => {
      const raw = '---\nname: foo\ndescription: d\nallowed-tools: Bash(python *) Bash(ls *)\n---\n';
      const res = parseSkillFile(raw, 'test');
      expect(res.metadata.allowedTools).toEqual(['Bash(python', '*)', 'Bash(ls', '*)']);
    });

    it('preserves unknown frontmatter fields', () => {
      const raw = [
        '---',
        'name: foo',
        'description: d',
        'custom-field: something',
        'another: 42',
        '---',
      ].join('\n') + '\n';
      const res = parseSkillFile(raw, 'test');
      expect(res.metadata.unknownFields?.['custom-field']).toBe('something');
      expect(res.metadata.unknownFields?.another).toBe(42);
      expect(res.warnings.some((w) => w.includes('custom-field'))).toBe(true);
    });

    it('records Claude Code-only fields in unknownFields without warnings', () => {
      const raw = [
        '---',
        'name: foo',
        'description: d',
        'disable-model-invocation: false',
        'user-invocable: true',
        'model: claude-opus',
        'paths: "**/*.pdf"',
        '---',
      ].join('\n') + '\n';
      const res = parseSkillFile(raw, 'test');
      expect(res.metadata.unknownFields?.['disable-model-invocation']).toBe(false);
      expect(res.metadata.unknownFields?.['user-invocable']).toBe(true);
      expect(res.metadata.unknownFields?.model).toBe('claude-opus');
      expect(res.metadata.unknownFields?.paths).toBe('**/*.pdf');
      // These Claude-only fields don't produce warnings.
      expect(res.warnings).toEqual([]);
    });

    it('warns about non-bash shell values', () => {
      const raw = '---\nname: foo\ndescription: d\nshell: powershell\n---\n';
      const res = parseSkillFile(raw, 'test');
      expect(res.metadata.shell).toBeUndefined();
      expect(res.warnings.some((w) => w.includes('powershell'))).toBe(true);
    });

    it('rejects description over 1024 chars', () => {
      const long = 'x'.repeat(1025);
      const raw = `---\nname: foo\ndescription: "${long}"\n---\n`;
      expect(() => parseSkillFile(raw, 'test')).toThrow(/description/);
    });
  });
});
