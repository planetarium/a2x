import { describe, it, expect } from 'vitest';
import { substitute, splitArguments } from '../skills/substitution.js';
import { defineSkill } from '../skills/define-skill.js';

const skill = defineSkill({
  name: 'test',
  description: 'test skill',
  body: '',
});

const baseCtx = {
  skill,
  sessionId: 'sess-123',
  arguments: '',
  enableClaudeVarCompat: true,
};

describe('Layer 2: Skills substitution', () => {
  describe('splitArguments', () => {
    it('splits by whitespace', () => {
      expect(splitArguments('a b c')).toEqual(['a', 'b', 'c']);
    });

    it('handles leading/trailing whitespace', () => {
      expect(splitArguments('  a  b  ')).toEqual(['a', 'b']);
    });

    it('returns [] for empty', () => {
      expect(splitArguments('')).toEqual([]);
      expect(splitArguments('   ')).toEqual([]);
    });
  });

  describe('variable substitution', () => {
    it('substitutes ${A2X_SKILL_DIR}', () => {
      const out = substitute('dir=${A2X_SKILL_DIR}', baseCtx);
      expect(out).toBe('dir=inline:test');
    });

    it('substitutes ${A2X_SESSION_ID}', () => {
      const out = substitute('sid=${A2X_SESSION_ID}', baseCtx);
      expect(out).toBe('sid=sess-123');
    });

    it('substitutes ${CLAUDE_SKILL_DIR} when enableClaudeVarCompat is true', () => {
      const out = substitute('dir=${CLAUDE_SKILL_DIR}', baseCtx);
      expect(out).toBe('dir=inline:test');
    });

    it('leaves ${CLAUDE_SKILL_DIR} empty when compat is disabled', () => {
      const out = substitute('dir=${CLAUDE_SKILL_DIR}', {
        ...baseCtx,
        enableClaudeVarCompat: false,
      });
      expect(out).toBe('dir=');
    });

    it('substitutes $ARGUMENTS with the whole raw string', () => {
      const out = substitute('args=$ARGUMENTS done', {
        ...baseCtx,
        arguments: 'foo bar',
      });
      expect(out).toBe('args=foo bar done');
    });

    it('substitutes $0, $1 tokens', () => {
      const out = substitute('$0 + $1 = $2', {
        ...baseCtx,
        arguments: 'a b c',
      });
      expect(out).toBe('a + b = c');
    });

    it('substitutes $ARGUMENTS[N] tokens', () => {
      const out = substitute('second=$ARGUMENTS[1]', {
        ...baseCtx,
        arguments: 'a b c',
      });
      expect(out).toBe('second=b');
    });

    it('undefined tokens substitute to empty string', () => {
      const out = substitute('third=$2', {
        ...baseCtx,
        arguments: 'a b',
      });
      expect(out).toBe('third=');
    });

    it('does not substitute $ when preceded by identifier', () => {
      const out = substitute('FOO$0', {
        ...baseCtx,
        arguments: 'x',
      });
      // `FOO$0` must remain literal — `F` is an identifier character.
      expect(out).toBe('FOO$0');
    });

    it('handles escape \\${VAR}', () => {
      const out = substitute('dir=\\${A2X_SKILL_DIR}', baseCtx);
      expect(out).toBe('dir=${A2X_SKILL_DIR}');
    });

    it('handles escape \\$ARGUMENTS', () => {
      const out = substitute('args=\\$ARGUMENTS', {
        ...baseCtx,
        arguments: 'x',
      });
      expect(out).toBe('args=$ARGUMENTS');
    });

    it('unknown braced variable substitutes to empty string', () => {
      const out = substitute('x=${UNKNOWN_VAR}', baseCtx);
      expect(out).toBe('x=');
    });
  });
});
