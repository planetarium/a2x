import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillLoader } from '../skills/loader.js';
import {
  SkillConfigError,
  SkillDiscoveryError,
} from '../skills/errors.js';
import { defineSkill } from '../skills/define-skill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, 'fixtures/skills');
const ANTHROPIC_FIXTURES = path.resolve(__dirname, 'fixtures/skills-anthropic');

describe('Layer 2: Skills loader', () => {
  describe('configuration validation', () => {
    it('returns an empty registry when no config is provided', async () => {
      const res = await SkillLoader.load(undefined);
      expect(res.registry.size).toBe(0);
      expect(res.registry.isEmpty).toBe(true);
    });

    it('rejects a relative root path', async () => {
      await expect(
        SkillLoader.load({ root: './relative/path' }),
      ).rejects.toBeInstanceOf(SkillConfigError);
    });

    it('rejects a non-string root', async () => {
      await expect(
        SkillLoader.load({ root: 42 as unknown as string }),
      ).rejects.toBeInstanceOf(SkillConfigError);
    });

    it('rejects a non-array inline', async () => {
      await expect(
        SkillLoader.load({ inline: 'nope' as unknown as never }),
      ).rejects.toBeInstanceOf(SkillConfigError);
    });

    it('rejects an unknown scriptMode', async () => {
      await expect(
        SkillLoader.load({
          root: FIXTURES,
          scriptMode: 'maybe' as unknown as 'allow',
        }),
      ).rejects.toBeInstanceOf(SkillConfigError);
    });

    it('rejects a root that does not exist', async () => {
      await expect(
        SkillLoader.load({ root: path.join(FIXTURES, '__does_not_exist__') }),
      ).rejects.toBeInstanceOf(SkillDiscoveryError);
    });
  });

  describe('discovery', () => {
    it('discovers valid skills beneath the root recursively', async () => {
      // Only the valid-simple + valid-full fixtures should register; the
      // invalid fixtures get rejected (but not fatally), and the duplicate
      // pair raises SkillConfigError.
      const root = path.join(FIXTURES, 'valid-simple');
      const res = await SkillLoader.load({ root });
      expect(res.registry.names()).toContain('valid-simple');
    });

    it('fatal-errors on duplicate skill names under the same root', async () => {
      await expect(SkillLoader.load({ root: FIXTURES })).rejects.toBeInstanceOf(SkillConfigError);
    });

    it('collects rejections for individually invalid SKILL.md files', async () => {
      // Run against a temporary root that only contains invalid fixtures so
      // there are no duplicates.
      const { registry, rejections } = await SkillLoader.load({
        root: path.join(FIXTURES, 'invalid-bad-name'),
      });
      expect(registry.size).toBe(0);
      expect(rejections.length).toBeGreaterThan(0);
      expect(rejections[0].source.endsWith('SKILL.md')).toBe(true);
    });

    it('loads full fixture with references and scripts', async () => {
      const { registry } = await SkillLoader.load({
        root: path.join(FIXTURES, 'valid-full'),
      });
      const skill = registry.get('valid-full');
      expect(skill).toBeDefined();
      const body = await skill!.loadBody();
      expect(body.raw).toContain('valid-full');
      expect(body.referencedFiles).toContain('FORMS.md');
      expect(body.referencedFiles).toContain('REFERENCE.md');
    });

    it('keeps anthropic-style fixtures working without modification', async () => {
      const { registry, rejections } = await SkillLoader.load({
        root: ANTHROPIC_FIXTURES,
      });
      expect(rejections).toEqual([]);
      expect(registry.names()).toEqual(
        ['commit-helper', 'pdf-processing', 'reference-heavy'],
      );
      const pdf = registry.get('pdf-processing');
      expect(pdf?.metadata.unknownFields?.agent).toBe('Explore');
      expect(pdf?.metadata.unknownFields?.['disable-model-invocation']).toBe(false);
    });
  });

  describe('inline skills', () => {
    it('registers inline skills alongside file skills', async () => {
      const inline = defineSkill({
        name: 'inline-only',
        description: 'inline test skill',
        body: '# inline body\n',
      });
      const { registry } = await SkillLoader.load({
        root: path.join(FIXTURES, 'valid-simple'),
        inline: [inline],
      });
      expect(registry.names().sort()).toEqual(['inline-only', 'valid-simple'].sort());
    });

    it('rejects duplicate inline names', async () => {
      const a = defineSkill({ name: 'dup', description: 'a', body: '' });
      const b = defineSkill({ name: 'dup', description: 'b', body: '' });
      await expect(
        SkillLoader.load({ inline: [a, b] }),
      ).rejects.toBeInstanceOf(SkillConfigError);
    });

    it('rejects collisions between inline and file skills', async () => {
      const inline = defineSkill({
        name: 'valid-simple',
        description: 'conflicting inline skill',
        body: '',
      });
      await expect(
        SkillLoader.load({
          root: path.join(FIXTURES, 'valid-simple'),
          inline: [inline],
        }),
      ).rejects.toBeInstanceOf(SkillConfigError);
    });

    it('inline skills preserve metadata.unknownFields = undefined', async () => {
      const inline = defineSkill({ name: 'x', description: 'y', body: '' });
      expect(inline.source).toBe('inline');
      expect(inline.skillDir).toBe('inline:x');
      expect(inline.metadata.unknownFields).toBeUndefined();
    });
  });
});
