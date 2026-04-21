/**
 * Layer 2: Claude Agent Skills runtime - error hierarchy.
 *
 * These errors are intentionally separate from the JSON-RPC `A2AError`
 * hierarchy because the skill runtime operates outside the JSON-RPC layer.
 * They all extend the built-in `Error` so they integrate cleanly with
 * existing `try/catch` / `instanceof` usage.
 */

export interface SkillErrorOptions {
  /** Source identifier such as an absolute SKILL.md path or `inline:<name>`. */
  source?: string;
  /** Underlying cause. */
  cause?: unknown;
}

/**
 * Base class for all skill runtime errors. Callers can `instanceof SkillError`
 * to handle any skill-related failure generically.
 */
export class SkillError extends Error {
  readonly source?: string;

  constructor(message: string, options?: SkillErrorOptions) {
    super(message, options as ErrorOptions);
    this.name = this.constructor.name;
    this.source = options?.source;
  }
}

/**
 * Thrown when the `skills` option shape is invalid (e.g. relative root path,
 * duplicate tool names, malformed inline skill).
 */
export class SkillConfigError extends SkillError {}

/**
 * Thrown when the skill root could not be scanned (e.g. directory does not
 * exist, not a directory, I/O failure during enumeration).
 */
export class SkillDiscoveryError extends SkillError {}

/**
 * Thrown when a SKILL.md frontmatter is malformed or violates the standard's
 * invariants (missing name/description, illegal characters, reserved word).
 */
export class SkillParseError extends SkillError {}

/**
 * Thrown when a `read_skill_file` or `run_skill_script` call cannot complete
 * due to path escape, missing file, or spawn failure.
 */
export class SkillExecutionError extends SkillError {}
