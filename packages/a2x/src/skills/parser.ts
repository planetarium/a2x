/**
 * Layer 2: Skill runtime - SKILL.md parser.
 *
 * Parses a SKILL.md file into an `AgentSkillMetadata` + raw body pair. The
 * parsing is strictly local — it does NOT touch the filesystem. Callers
 * (e.g. `SkillLoader`) supply the raw file contents.
 */

import { parseYaml, YamlParseError, type YamlValue } from './yaml.js';
import { SkillParseError } from './errors.js';
import type { AgentSkillMetadata } from './types.js';

// Frontmatter fence: `---` followed by a newline. Accepts `\r\n` as newline
// separator for Windows-authored files.
const FENCE_OPEN = /^---\r?\n/;
const FENCE_CLOSE = /\r?\n---\r?\n?/;

/** Length ceilings from the Claude Agent Skills standard. */
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_COMBINED_MAX = 1536;

/** Regex for skill names. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  'anthropic',
  'claude',
]);

/** Keys that the SDK translates verbatim between YAML and internal fields. */
const KEY_MAP: Record<string, keyof AgentSkillMetadata> = {
  name: 'name',
  description: 'description',
  when_to_use: 'whenToUse',
  'when-to-use': 'whenToUse',
  'allowed-tools': 'allowedTools',
  allowed_tools: 'allowedTools',
  'argument-hint': 'argumentHint',
  argument_hint: 'argumentHint',
  shell: 'shell',
};

/**
 * Fields the SDK explicitly ignores in the runtime but preserves via
 * `unknownFields` for external auditors.
 */
const KNOWN_BUT_UNUSED = new Set([
  'disable-model-invocation',
  'user-invocable',
  'model',
  'effort',
  'context',
  'agent',
  'paths',
  'hooks',
]);

export interface ParsedSkillFile {
  readonly metadata: AgentSkillMetadata;
  readonly body: string;
  readonly warnings: readonly string[];
}

/**
 * Parse a SKILL.md file's contents.
 *
 * @param source Identifier for diagnostics (absolute path or `inline:<name>`).
 */
export function parseSkillFile(
  raw: string,
  source: string,
): ParsedSkillFile {
  const warnings: string[] = [];
  const openMatch = FENCE_OPEN.exec(raw);
  if (!openMatch) {
    throw new SkillParseError(
      'SKILL.md must start with a YAML frontmatter block "---"',
      { source },
    );
  }
  const afterOpen = raw.slice(openMatch[0].length);
  const closeMatch = FENCE_CLOSE.exec(afterOpen);
  if (!closeMatch) {
    throw new SkillParseError(
      'SKILL.md is missing the closing "---" frontmatter fence',
      { source },
    );
  }
  const yamlBlock = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  let parsed: Record<string, YamlValue>;
  try {
    parsed = parseYaml(yamlBlock);
  } catch (err) {
    if (err instanceof YamlParseError) {
      throw new SkillParseError(`YAML frontmatter parse error: ${err.message}`, {
        source,
        cause: err,
      });
    }
    throw err;
  }

  const metadata = validate(parsed, source, warnings);
  return { metadata, body, warnings };
}

function validate(
  raw: Record<string, YamlValue>,
  source: string,
  warnings: string[],
): AgentSkillMetadata {
  const unknownFields: Record<string, unknown> = {};
  const claim: Partial<Record<keyof AgentSkillMetadata, YamlValue>> = {};

  for (const [rawKey, value] of Object.entries(raw)) {
    const mapped = KEY_MAP[rawKey];
    if (mapped) {
      claim[mapped] = value;
    } else {
      unknownFields[rawKey] = value;
      if (!KNOWN_BUT_UNUSED.has(rawKey)) {
        warnings.push(`unknown frontmatter field "${rawKey}"`);
      }
    }
  }

  // name
  const name = claim.name;
  if (typeof name !== 'string' || name === '') {
    throw new SkillParseError('frontmatter "name" is required', { source });
  }
  if (!SKILL_NAME_RE.test(name)) {
    throw new SkillParseError(
      `frontmatter "name" must match ${SKILL_NAME_RE} (got "${name}")`,
      { source },
    );
  }
  if (SKILL_FORBIDDEN_NAMES.has(name)) {
    throw new SkillParseError(
      `frontmatter "name" "${name}" is reserved and cannot be used`,
      { source },
    );
  }
  if (name.length > SKILL_NAME_MAX) {
    throw new SkillParseError(
      `frontmatter "name" exceeds ${SKILL_NAME_MAX} chars`,
      { source },
    );
  }

  // description
  const description = claim.description;
  if (typeof description !== 'string' || description === '') {
    throw new SkillParseError('frontmatter "description" is required', { source });
  }
  if (description.length > SKILL_DESCRIPTION_MAX) {
    throw new SkillParseError(
      `frontmatter "description" exceeds ${SKILL_DESCRIPTION_MAX} chars`,
      { source },
    );
  }

  // when_to_use
  let whenToUse: string | undefined;
  if (claim.whenToUse !== undefined) {
    if (typeof claim.whenToUse !== 'string') {
      throw new SkillParseError(
        'frontmatter "when_to_use" must be a string',
        { source },
      );
    }
    whenToUse = claim.whenToUse;
    const combined = description.length + whenToUse.length;
    if (combined > SKILL_COMBINED_MAX) {
      warnings.push(
        `combined description + when_to_use length (${combined}) exceeds recommended ${SKILL_COMBINED_MAX}`,
      );
    }
  }

  // allowed-tools
  let allowedTools: readonly string[] | undefined;
  if (claim.allowedTools !== undefined) {
    allowedTools = normaliseAllowedTools(claim.allowedTools, source);
  }

  // argument-hint
  let argumentHint: string | undefined;
  if (claim.argumentHint !== undefined) {
    if (typeof claim.argumentHint !== 'string') {
      throw new SkillParseError(
        'frontmatter "argument-hint" must be a string',
        { source },
      );
    }
    argumentHint = claim.argumentHint;
  }

  // shell
  let shell: 'bash' | undefined;
  if (claim.shell !== undefined) {
    if (typeof claim.shell !== 'string') {
      throw new SkillParseError(
        'frontmatter "shell" must be a string',
        { source },
      );
    }
    if (claim.shell === 'bash') {
      shell = 'bash';
    } else {
      warnings.push(`shell "${claim.shell}" is not supported; ignoring`);
    }
  }

  const meta: AgentSkillMetadata = {
    name,
    description,
    whenToUse,
    allowedTools,
    argumentHint,
    shell,
    unknownFields: Object.keys(unknownFields).length > 0
      ? Object.freeze({ ...unknownFields })
      : undefined,
  };
  return Object.freeze(meta);
}

function normaliseAllowedTools(
  value: YamlValue,
  source: string,
): readonly string[] {
  if (typeof value === 'string') {
    return Object.freeze(
      value
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    );
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => {
      if (typeof v !== 'string') {
        throw new SkillParseError(
          'frontmatter "allowed-tools" list items must be strings',
          { source },
        );
      }
      return v;
    });
    return Object.freeze(items);
  }
  throw new SkillParseError(
    'frontmatter "allowed-tools" must be a string or array of strings',
    { source },
  );
}
