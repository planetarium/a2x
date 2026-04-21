/**
 * Layer 2: Skill runtime - inline skill helper (`defineSkill`).
 *
 * `defineSkill(input)` returns a normalised `AgentSkill` that is
 * indistinguishable from a file-loaded skill when viewed through the public
 * `AgentSkill` surface. Differences live in `readInlineAsset` (inline
 * buffers) and in how `run_skill_script` dispatches (function vs. spawn).
 */

import { SkillConfigError } from './errors.js';
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_FORBIDDEN_NAMES,
  SKILL_NAME_MAX,
  SKILL_NAME_RE,
} from './parser.js';
import type {
  AgentSkill,
  AgentSkillBody,
  AgentSkillMetadata,
  DefineSkillInput,
  InlineScriptHandler,
} from './types.js';

/**
 * Build a normalised `AgentSkill` from inline inputs. The return value is safe
 * to pass directly into `LlmAgentOptions.skills.inline`.
 */
export function defineSkill(input: DefineSkillInput): AgentSkill {
  if (!input || typeof input !== 'object') {
    throw new SkillConfigError('defineSkill: input must be an object');
  }
  const { name, description } = input;
  if (typeof name !== 'string' || name === '') {
    throw new SkillConfigError('defineSkill: "name" is required');
  }
  if (!SKILL_NAME_RE.test(name) || name.length > SKILL_NAME_MAX) {
    throw new SkillConfigError(
      `defineSkill: "name" must match ${SKILL_NAME_RE} (got "${name}")`,
    );
  }
  if (SKILL_FORBIDDEN_NAMES.has(name)) {
    throw new SkillConfigError(
      `defineSkill: "name" "${name}" is reserved`,
    );
  }
  if (typeof description !== 'string' || description === '') {
    throw new SkillConfigError('defineSkill: "description" is required');
  }
  if (description.length > SKILL_DESCRIPTION_MAX) {
    throw new SkillConfigError(
      `defineSkill: "description" exceeds ${SKILL_DESCRIPTION_MAX} chars`,
    );
  }
  if (input.whenToUse !== undefined && typeof input.whenToUse !== 'string') {
    throw new SkillConfigError('defineSkill: "whenToUse" must be a string');
  }
  if (input.argumentHint !== undefined && typeof input.argumentHint !== 'string') {
    throw new SkillConfigError('defineSkill: "argumentHint" must be a string');
  }
  if (typeof input.body !== 'string') {
    throw new SkillConfigError('defineSkill: "body" must be a string');
  }

  const allowedTools = input.allowedTools
    ? Object.freeze([...input.allowedTools])
    : undefined;

  const metadata: AgentSkillMetadata = Object.freeze({
    name,
    description,
    whenToUse: input.whenToUse,
    allowedTools,
    argumentHint: input.argumentHint,
    shell: undefined,
    unknownFields: undefined,
  });

  // Normalise resources + scripts into a single lookup keyed by POSIX
  // relative path.
  const assets = new Map<string, string | Buffer>();
  const scriptHandlers = new Map<string, InlineScriptHandler>();

  if (input.resources) {
    for (const [key, value] of Object.entries(input.resources)) {
      const rel = assertInlineKey(key, name, 'resources');
      assets.set(rel, value);
    }
  }
  if (input.scripts) {
    for (const [key, value] of Object.entries(input.scripts)) {
      const rel = assertInlineKey(key, name, 'scripts');
      if (!rel.startsWith('scripts/')) {
        throw new SkillConfigError(
          `defineSkill: "${name}" script key "${key}" must start with "scripts/"`,
        );
      }
      if (typeof value === 'function') {
        scriptHandlers.set(rel, value);
      } else {
        assets.set(rel, value);
      }
    }
  }

  const referencedFiles = Object.freeze(
    Array.from(assets.keys()).filter((k) => !scriptHandlers.has(k)).sort(),
  );
  const bodyPromise: Promise<AgentSkillBody> = Promise.resolve(
    Object.freeze({
      raw: input.body,
      referencedFiles,
    }),
  );

  const skillDir = `inline:${name}`;

  const skill: AgentSkill = {
    metadata,
    source: 'inline',
    skillDir,
    loadBody() { return bodyPromise; },
    resolveFile(rel: string) {
      if (typeof rel !== 'string' || rel === '') return null;
      if (rel.includes('..')) return null;
      if (rel.startsWith('/')) return null;
      // Accept either a resource path or a script path.
      if (assets.has(rel) || scriptHandlers.has(rel)) {
        return `${skillDir}/${rel}`;
      }
      return null;
    },
    readInlineAsset(rel: string) {
      if (typeof rel !== 'string' || rel === '') return null;
      const hit = assets.get(rel);
      return hit ?? null;
    },
  };
  // Expose the inline script handler lookup via a non-enumerable property so
  // the `run_skill_script` tool can detect function-backed scripts without
  // relying on filesystem behaviour.
  Object.defineProperty(skill, Symbol.for('@a2x/sdk.inlineScriptHandlers'), {
    value: scriptHandlers,
    enumerable: false,
    writable: false,
  });
  return skill;
}

/** Symbol used to attach an inline script handler map onto an `AgentSkill`. */
export const INLINE_SCRIPT_HANDLERS = Symbol.for('@a2x/sdk.inlineScriptHandlers');

/**
 * Retrieve the inline script handler registered via `defineSkill`. Returns
 * `undefined` when the skill has none (file-based skills, or inline skills
 * without functional scripts).
 */
export function getInlineScriptHandler(
  skill: AgentSkill,
  relPath: string,
): InlineScriptHandler | undefined {
  const map = (skill as unknown as Record<symbol, unknown>)[INLINE_SCRIPT_HANDLERS];
  if (!(map instanceof Map)) return undefined;
  const hit = map.get(relPath);
  if (typeof hit !== 'function') return undefined;
  return hit;
}

function assertInlineKey(
  key: string,
  skillName: string,
  kind: 'resources' | 'scripts',
): string {
  if (typeof key !== 'string' || key === '') {
    throw new SkillConfigError(
      `defineSkill: "${skillName}" ${kind} key must be a non-empty string`,
    );
  }
  if (key.startsWith('/') || key.startsWith('\\')) {
    throw new SkillConfigError(
      `defineSkill: "${skillName}" ${kind} key must be relative (got "${key}")`,
    );
  }
  if (key.includes('..')) {
    throw new SkillConfigError(
      `defineSkill: "${skillName}" ${kind} key must not contain ".." (got "${key}")`,
    );
  }
  // Normalise separator to POSIX.
  return key.split('\\').join('/');
}
