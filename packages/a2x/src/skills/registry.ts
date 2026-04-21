/**
 * Layer 2: Skill runtime - in-memory skill registry.
 *
 * Holds the frozen metadata set for all skills registered to a single
 * `LlmAgent` instance plus a body cache shared across all sessions of the same
 * process. Instances are produced exclusively by `SkillLoader.load(...)`.
 */

import type {
  AgentSkill,
  AgentSkillBody,
  SkillLogger,
  SkillsConfig,
} from './types.js';

export interface SkillRegistryOptions {
  readonly enableClaudeVarCompat: boolean;
  readonly scriptMode: 'allow' | 'confirm' | 'deny';
  readonly onScriptExecute?: SkillsConfig['onScriptExecute'];
  readonly logger?: SkillLogger;
}

export class SkillRegistry {
  private readonly _skills: ReadonlyMap<string, AgentSkill>;
  private readonly _bodyCache = new Map<string, Promise<AgentSkillBody>>();
  private readonly _opts: SkillRegistryOptions;

  constructor(skills: Iterable<AgentSkill>, opts: SkillRegistryOptions) {
    const map = new Map<string, AgentSkill>();
    for (const s of skills) {
      map.set(s.metadata.name, s);
    }
    this._skills = map;
    this._opts = Object.freeze({ ...opts });
  }

  /** Total number of registered skills. */
  get size(): number {
    return this._skills.size;
  }

  /** Whether at least one skill is registered. */
  get isEmpty(): boolean {
    return this._skills.size === 0;
  }

  /** Effective logger (falls back to console-like warn). */
  get logger(): SkillLogger {
    return this._opts.logger ?? DEFAULT_LOGGER;
  }

  /** Configured script execution mode. */
  get scriptMode(): 'allow' | 'confirm' | 'deny' {
    return this._opts.scriptMode;
  }

  /** Hook invoked before a script is executed (if any). */
  get onScriptExecute(): SkillsConfig['onScriptExecute'] | undefined {
    return this._opts.onScriptExecute;
  }

  /** Whether `${CLAUDE_*}` variables should be substituted. */
  get enableClaudeVarCompat(): boolean {
    return this._opts.enableClaudeVarCompat;
  }

  /** Snapshot of all skills, sorted by name for stable downstream output. */
  list(): readonly AgentSkill[] {
    return Array.from(this._skills.values()).sort((a, b) =>
      a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0,
    );
  }

  get(name: string): AgentSkill | undefined {
    return this._skills.get(name);
  }

  has(name: string): boolean {
    return this._skills.has(name);
  }

  /** Names of registered skills (sorted). */
  names(): readonly string[] {
    return this.list().map((s) => s.metadata.name);
  }

  /**
   * Load (and cache) the parsed body for a skill. Returns the same `Promise`
   * for repeated calls with the same name.
   */
  loadBody(name: string): Promise<AgentSkillBody> {
    const skill = this._skills.get(name);
    if (!skill) {
      return Promise.reject(new Error(`unknown skill: ${name}`));
    }
    const cached = this._bodyCache.get(name);
    if (cached) return cached;
    const p = skill.loadBody();
    this._bodyCache.set(name, p);
    // If the body fails to load we remove the cache entry so retries succeed.
    p.catch(() => this._bodyCache.delete(name));
    return p;
  }
}

const DEFAULT_LOGGER: SkillLogger = {
  warn(msg, meta) {
    if (meta !== undefined) {
      console.warn(`[a2x:skills] ${msg}`, meta);
    } else {
      console.warn(`[a2x:skills] ${msg}`);
    }
  },
};
