/**
 * Layer 2: Skill runtime - public API.
 *
 * Only the types and functions re-exported here are considered part of the
 * `@a2x/sdk` public surface. Internals such as `SkillRegistry`, `SkillLoader`
 * and the builtin tool classes are intentionally omitted.
 */

export type {
  SkillsConfig,
  SkillLogger,
  AgentSkill,
  AgentSkillMetadata,
  AgentSkillBody,
  SkillScriptExecutionMeta,
  DefineSkillInput,
  InlineScriptHandler,
} from './types.js';

export { defineSkill } from './define-skill.js';

export {
  SkillError,
  SkillParseError,
  SkillDiscoveryError,
  SkillConfigError,
  SkillExecutionError,
} from './errors.js';
