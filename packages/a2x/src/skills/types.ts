/**
 * Layer 2: Claude Agent Skills runtime - public types.
 *
 * Types here describe the open Claude Agent Skills standard as it is integrated
 * into `@a2x/sdk`. They are intentionally namespaced with `AgentSkill*` to avoid
 * confusion with A2A `A2XAgentSkill` (AgentCard.skills), which is an entirely
 * different concept.
 */

import type { InvocationContext } from '../runner/context.js';

// ─── Logger ───

/**
 * Logger interface used by skill runtime components.
 * Defaults to `console.warn` when not supplied.
 */
export interface SkillLogger {
  /** Report warnings such as unknown frontmatter keys or missing variables. */
  warn(msg: string, meta?: Record<string, unknown>): void;
  /** Report optional informational events such as registration summaries. */
  info?(msg: string, meta?: Record<string, unknown>): void;
}

// ─── Skill Metadata & Body ───

/**
 * Parsed metadata from a SKILL.md YAML frontmatter block.
 */
export interface AgentSkillMetadata {
  /** Unique identifier. 64 chars max, lowercase letters/digits/hyphens only. */
  readonly name: string;
  /** What the skill does and when it should be used (max 1024 chars). */
  readonly description: string;
  /**
   * Optional addendum that is combined with `description` when producing the
   * prompt-block description. Parsed from `when_to_use` / `when-to-use`.
   */
  readonly whenToUse?: string;
  /**
   * Declared-but-unenforced tool allow list. Kept for audit only; the runtime
   * does not enforce this list.
   */
  readonly allowedTools?: readonly string[];
  /** Autocomplete hint (display only in A2X). */
  readonly argumentHint?: string;
  /** Only `'bash'` is supported in the MVP. */
  readonly shell?: 'bash';
  /**
   * Unknown (non-SDK-recognised) frontmatter fields are preserved verbatim for
   * downstream audit. Undefined when all keys were recognised.
   */
  readonly unknownFields?: Readonly<Record<string, unknown>>;
}

/**
 * Parsed body of a SKILL.md (frontmatter already stripped).
 */
export interface AgentSkillBody {
  /** Raw markdown body as it appears in SKILL.md (no substitution applied). */
  readonly raw: string;
  /**
   * Referenced files (relative to `skillDir`) that actually exist on disk.
   * For inline skills, paths correspond to keys in the `resources` map.
   */
  readonly referencedFiles: readonly string[];
}

/**
 * A registered Claude Agent Skill.
 *
 * Inline skills (created with `defineSkill`) and file-backed skills share the
 * same shape. The `source` field and the `readInlineAsset` method are the
 * only places the two implementations differ.
 */
export interface AgentSkill {
  readonly metadata: AgentSkillMetadata;
  /** Where the skill came from. */
  readonly source: 'file' | 'inline';
  /**
   * Absolute directory containing SKILL.md (file mode) or a virtual identifier
   * of the form `inline:<name>` (inline mode).
   */
  readonly skillDir: string;
  /**
   * Lazily load and parse the body. The same `Promise` should be reused so that
   * repeated calls within a process return the same object.
   */
  loadBody(): Promise<AgentSkillBody>;
  /**
   * Resolve the absolute path of a file referenced from `skillDir`.
   * Returns null if the path escapes the skill directory or is otherwise
   * invalid. For inline skills, returns a virtual path of the form
   * `inline:<name>/<relative>` that callers can pair with `readInlineAsset`.
   */
  resolveFile(relativePath: string): string | null;
  /**
   * For inline skills only: return the raw asset bytes/string for a path that
   * appears in `resources`/`scripts`. Returns null when the skill is file-based
   * or the key is not present.
   */
  readInlineAsset?(relativePath: string): Buffer | string | null;
}

// ─── Configuration ───

/**
 * Metadata passed to `SkillsConfig.onScriptExecute` so the host can audit or
 * approve a `run_skill_script` invocation.
 */
export interface SkillScriptExecutionMeta {
  /** The skill that owns the script being executed. */
  readonly skillName: string;
  /** Absolute path of the script to execute. */
  readonly scriptPath: string;
  /** Relative path inside the skill directory (always starts with `scripts/`). */
  readonly scriptRelativePath: string;
  /** Positional arguments that will be passed to the script. */
  readonly arguments: readonly string[];
  /** Session id from `InvocationContext.session.id`. */
  readonly sessionId: string;
  /** Agent name from `InvocationContext.agentName`. */
  readonly agentName: string;
  /** Current script execution mode. */
  readonly mode: 'allow' | 'confirm' | 'deny';
  /** Verbatim copy of the skill's `allowed-tools` declaration, if any. */
  readonly declaredAllowedTools?: readonly string[];
}

/**
 * Configuration for the Claude Agent Skills runtime. Passed via
 * `LlmAgentOptions.skills`.
 */
export interface SkillsConfig {
  /**
   * Absolute path to scan recursively for SKILL.md files. Must exist and be a
   * directory. Relative paths are rejected.
   */
  root?: string;
  /** Inline-defined skills produced by `defineSkill(...)`. */
  inline?: AgentSkill[];
  /**
   * Script execution policy.
   * - `'allow'` (default): run scripts immediately (hook still called for audit).
   * - `'confirm'`: run only when `onScriptExecute` returns a truthy value.
   * - `'deny'`: never run scripts.
   */
  scriptMode?: 'allow' | 'confirm' | 'deny';
  /**
   * Hook invoked immediately before a script is executed. Throwing from this
   * hook aborts the execution regardless of `scriptMode`. In `'confirm'` mode
   * its return value gates execution.
   */
  onScriptExecute?: (meta: SkillScriptExecutionMeta) => boolean | Promise<boolean>;
  /**
   * When true, `${CLAUDE_SKILL_DIR}` and `${CLAUDE_SESSION_ID}` are substituted
   * alongside `${A2X_*}`. Defaults to true for Anthropic-skill interop.
   */
  enableClaudeVarCompat?: boolean;
  /** Follow symbolic links while scanning. Defaults to false. */
  followSymlinks?: boolean;
  /** Logger. Defaults to `console.warn` / `console.info`. */
  logger?: SkillLogger;
}

// ─── defineSkill() input ───

/**
 * A script handler that can be invoked without spawning a child process.
 * Useful in bundler-constrained environments where an executable on disk is
 * not available.
 */
export type InlineScriptHandler = (input: {
  readonly arguments: readonly string[];
  readonly context: InvocationContext;
  readonly skill: AgentSkill;
}) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;

/**
 * Input for `defineSkill(...)`.
 */
export interface DefineSkillInput {
  /** Unique identifier (same format as file-based skills). */
  name: string;
  /** Skill description (max 1024 chars). */
  description: string;
  /** Optional addendum combined into the prompt description. */
  whenToUse?: string;
  /** Declared tool allow list (not enforced). */
  allowedTools?: readonly string[];
  /** Autocomplete hint (display only). */
  argumentHint?: string;
  /**
   * Markdown body. Whitespace is preserved; the leading/trailing newline is
   * normalised so that the body starts cleanly when rendered.
   */
  body: string;
  /**
   * In-memory assets addressable via `read_skill_file`. Keys must be POSIX
   * relative paths. `..` segments and absolute paths are rejected.
   *
   * Example: `{ 'FORMS.md': '# ...', 'resources/logo.png': Buffer.from(...) }`.
   */
  resources?: Readonly<Record<string, string | Buffer>>;
  /**
   * Inline scripts. Keys must start with `scripts/`. Values may be either the
   * raw script content or a function that the runtime invokes directly.
   */
  scripts?: Readonly<Record<string, string | Buffer | InlineScriptHandler>>;
}
