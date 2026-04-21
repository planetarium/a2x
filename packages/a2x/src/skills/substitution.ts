/**
 * Layer 2: Skill runtime - variable substitution engine.
 *
 * Applied to `load_skill` body output and `read_skill_file` content output.
 * The engine is intentionally forgiving: missing variables never throw, they
 * substitute to an empty string (FR-052).
 */

import type { AgentSkill, SkillLogger } from './types.js';

export interface SubstitutionContext {
  readonly skill: AgentSkill;
  readonly sessionId: string;
  /** Raw `arguments` string as received by the tool. */
  readonly arguments: string;
  /** When true, `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}` are substituted. */
  readonly enableClaudeVarCompat: boolean;
  readonly logger?: SkillLogger;
}

/** Split an `arguments` string by whitespace into positional tokens. */
export function splitArguments(raw: string): string[] {
  if (!raw) return [];
  return raw.split(/\s+/).map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Apply variable substitution to the given text.
 *
 * Supported variables:
 * - `${A2X_SKILL_DIR}`
 * - `${A2X_SESSION_ID}`
 * - `${CLAUDE_SKILL_DIR}` (when `enableClaudeVarCompat` is true)
 * - `${CLAUDE_SESSION_ID}` (when `enableClaudeVarCompat` is true)
 * - `$ARGUMENTS` → the whole arguments string
 * - `$ARGUMENTS[N]` / `$N` (N ≥ 0) → the N-th positional token
 *
 * Escape sequences:
 * - `\${VAR}`    → leaves a literal `${VAR}`
 * - `\\${VAR}`   → literal `\` followed by the substituted value
 */
export function substitute(body: string, ctx: SubstitutionContext): string {
  if (body === '') return body;
  const tokens = splitArguments(ctx.arguments);

  const varValue = (name: string): string | undefined => {
    switch (name) {
      case 'A2X_SKILL_DIR':
        return ctx.skill.skillDir;
      case 'A2X_SESSION_ID':
        return ctx.sessionId;
      case 'CLAUDE_SKILL_DIR':
        return ctx.enableClaudeVarCompat ? ctx.skill.skillDir : undefined;
      case 'CLAUDE_SESSION_ID':
        return ctx.enableClaudeVarCompat ? ctx.sessionId : undefined;
      default:
        return undefined;
    }
  };

  // 1. Braced placeholders: `${VAR}` with optional preceding backslash(es).
  let out = body.replace(
    /(\\{1,2})?\$\{([A-Z_][A-Z0-9_]*)\}/g,
    (match, esc: string | undefined, name: string) => {
      if (esc === '\\') {
        // `\${VAR}` → literal `${VAR}`
        return `$\{${name}\}`;
      }
      if (esc === '\\\\') {
        const value = varValue(name);
        if (value !== undefined) return `\\${value}`;
        // Unknown: keep a literal `\` + the original placeholder.
        return `\\$\{${name}\}`;
      }
      const value = varValue(name);
      if (value !== undefined) return value;
      ctx.logger?.warn?.(`unknown skill variable "${name}"`, {
        skill: ctx.skill.metadata.name,
      });
      return '';
    },
  );

  // 2. `$ARGUMENTS[N]` — must run before the bare `$ARGUMENTS` rule.
  out = out.replace(
    /(\\{1,2})?\$ARGUMENTS\[(\d+)\]/g,
    (_match, esc: string | undefined, idx: string) => {
      if (esc === '\\') return `$ARGUMENTS[${idx}]`;
      const n = Number.parseInt(idx, 10);
      const value = Number.isSafeInteger(n) && n >= 0 && n < tokens.length ? tokens[n] : '';
      if (esc === '\\\\') return `\\${value}`;
      return value;
    },
  );

  // 3. `$ARGUMENTS` (whole string).
  out = out.replace(
    /(\\{1,2})?\$ARGUMENTS(?![A-Z0-9_])/g,
    (_match, esc: string | undefined) => {
      if (esc === '\\') return '$ARGUMENTS';
      if (esc === '\\\\') return `\\${ctx.arguments}`;
      return ctx.arguments;
    },
  );

  // 4. `$N` positional tokens. Require a preceding boundary so that `\$5` and
  // inline `$0` work, but `value$0` does not. Also disallow multi-digit
  // numbers starting with 0 to avoid greedy mis-matches like `$10` when the
  // caller only provided tokens for `$0` + a following `0` literal.
  out = out.replace(
    /(^|[^A-Za-z0-9_\\])(\\{1,2})?\$(\d+)\b/g,
    (_match, prefix: string, esc: string | undefined, idx: string) => {
      if (esc === '\\') return `${prefix}$${idx}`;
      const n = Number.parseInt(idx, 10);
      const value = Number.isSafeInteger(n) && n >= 0 && n < tokens.length ? tokens[n] : '';
      if (esc === '\\\\') return `${prefix}\\${value}`;
      return `${prefix}${value}`;
    },
  );

  return out;
}
