/**
 * Layer 2: Skill runtime - filesystem + inline loader.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  SkillConfigError,
  SkillDiscoveryError,
  SkillError,
  SkillParseError,
} from './errors.js';
import { parseSkillFile } from './parser.js';
import { SkillRegistry } from './registry.js';
import type {
  AgentSkill,
  AgentSkillBody,
  SkillLogger,
  SkillsConfig,
} from './types.js';

export interface SkillLoaderRejection {
  /** Absolute SKILL.md path or inline identifier that was rejected. */
  readonly source: string;
  /** Human-readable reason. */
  readonly reason: string;
  /** Original error, if any. */
  readonly cause?: unknown;
}

export interface SkillLoaderResult {
  readonly registry: SkillRegistry;
  readonly warnings: readonly string[];
  readonly rejections: readonly SkillLoaderRejection[];
}

/**
 * Produce a frozen `SkillRegistry` from a `SkillsConfig`. Fatal configuration
 * problems (missing root, duplicate names, reserved words, …) raise
 * exceptions; per-file parse failures are collected into `rejections`.
 */
export class SkillLoader {
  static async load(config: SkillsConfig | undefined): Promise<SkillLoaderResult> {
    const warnings: string[] = [];
    const rejections: SkillLoaderRejection[] = [];

    if (config === undefined) {
      return {
        registry: new SkillRegistry([], {
          enableClaudeVarCompat: true,
          scriptMode: 'allow',
        }),
        warnings,
        rejections,
      };
    }

    // ─── Early synchronous validation ───
    if (config.root !== undefined) {
      if (typeof config.root !== 'string' || config.root === '') {
        throw new SkillConfigError('skills.root must be a non-empty string');
      }
      if (!path.isAbsolute(config.root)) {
        throw new SkillConfigError(
          `skills.root must be an absolute path (got: ${config.root})`,
        );
      }
    }
    if (config.inline !== undefined && !Array.isArray(config.inline)) {
      throw new SkillConfigError('skills.inline must be an array');
    }
    const scriptMode = config.scriptMode ?? 'allow';
    if (!SCRIPT_MODES.has(scriptMode)) {
      throw new SkillConfigError(
        `skills.scriptMode must be one of ${[...SCRIPT_MODES].join(', ')}`,
      );
    }
    if (
      config.onScriptExecute !== undefined
      && typeof config.onScriptExecute !== 'function'
    ) {
      throw new SkillConfigError('skills.onScriptExecute must be a function');
    }

    const logger = config.logger;
    const collected = new Map<string, AgentSkill>();

    // ─── Inline skills first ───
    if (config.inline && config.inline.length > 0) {
      for (const skill of config.inline) {
        validateAgentSkillShape(skill);
        if (collected.has(skill.metadata.name)) {
          throw new SkillConfigError(
            `duplicate inline skill name: "${skill.metadata.name}"`,
          );
        }
        collected.set(skill.metadata.name, skill);
      }
    }

    // ─── Filesystem scan ───
    if (config.root !== undefined) {
      await scanRoot(
        config.root,
        config.followSymlinks === true,
        collected,
        warnings,
        rejections,
        logger,
      );
    }

    // Summary log (FR-080) — only when we actually discovered skills.
    if (collected.size > 0 && logger?.info) {
      logger.info('Agent Skills registered', {
        count: collected.size,
        names: Array.from(collected.keys()).sort(),
      });
    }

    return {
      registry: new SkillRegistry(collected.values(), {
        enableClaudeVarCompat: config.enableClaudeVarCompat !== false,
        scriptMode,
        onScriptExecute: config.onScriptExecute,
        logger: config.logger,
      }),
      warnings,
      rejections,
    };
  }
}

const SCRIPT_MODES = new Set<'allow' | 'confirm' | 'deny'>([
  'allow',
  'confirm',
  'deny',
]);

function validateAgentSkillShape(skill: AgentSkill): void {
  if (!skill || typeof skill !== 'object') {
    throw new SkillConfigError('inline skill must be an object');
  }
  if (!skill.metadata || typeof skill.metadata.name !== 'string') {
    throw new SkillConfigError('inline skill is missing metadata.name');
  }
  if (typeof skill.loadBody !== 'function') {
    throw new SkillConfigError(
      `inline skill "${skill.metadata.name}" must implement loadBody()`,
    );
  }
  if (typeof skill.resolveFile !== 'function') {
    throw new SkillConfigError(
      `inline skill "${skill.metadata.name}" must implement resolveFile()`,
    );
  }
}

async function scanRoot(
  root: string,
  followSymlinks: boolean,
  collected: Map<string, AgentSkill>,
  warnings: string[],
  rejections: SkillLoaderRejection[],
  logger: SkillLogger | undefined,
): Promise<void> {
  let rootStat;
  try {
    rootStat = await fs.stat(root);
  } catch (err) {
    throw new SkillDiscoveryError(
      `skills.root does not exist or is not accessible: ${root}`,
      { source: root, cause: err },
    );
  }
  if (!rootStat.isDirectory()) {
    throw new SkillDiscoveryError(
      `skills.root is not a directory: ${root}`,
      { source: root },
    );
  }

  // Gather SKILL.md absolute paths using a bounded DFS so we can handle
  // symlink loops deterministically even on Node versions where the
  // `recursive` readdir flag doesn't follow links.
  const skillFiles: string[] = [];
  const seenInodes = new Set<string>();
  await walk(root, followSymlinks, seenInodes, skillFiles, warnings, logger);

  // Parse + register in deterministic order.
  skillFiles.sort();
  for (const abs of skillFiles) {
    try {
      const raw = await fs.readFile(abs, 'utf8');
      const { metadata, body, warnings: parseWarnings } = parseSkillFile(raw, abs);
      for (const w of parseWarnings) {
        warnings.push(`${abs}: ${w}`);
        logger?.warn?.(`${abs}: ${w}`);
      }
      if (collected.has(metadata.name)) {
        const existing = collected.get(metadata.name)!;
        const existingSource = existing.source === 'file'
          ? existing.skillDir
          : `inline:${existing.metadata.name}`;
        throw new SkillConfigError(
          `duplicate skill name "${metadata.name}" (existing: ${existingSource}, new: ${abs})`,
          { source: abs },
        );
      }
      const skill = createFileSkill(abs, metadata, body);
      collected.set(metadata.name, skill);
    } catch (err) {
      if (err instanceof SkillConfigError) {
        // Fatal (e.g. duplicate name) — surface up.
        throw err;
      }
      if (err instanceof SkillError || err instanceof SkillParseError) {
        rejections.push({ source: abs, reason: err.message, cause: err });
        logger?.warn?.(`rejected skill at ${abs}: ${err.message}`);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      rejections.push({ source: abs, reason: message, cause: err });
      logger?.warn?.(`rejected skill at ${abs}: ${message}`);
    }
  }
}

async function walk(
  dir: string,
  followSymlinks: boolean,
  seenInodes: Set<string>,
  out: string[],
  warnings: string[],
  logger: SkillLogger | undefined,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Permission problems or broken links at the root level are reported as
    // warnings instead of aborting the whole scan.
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`failed to read directory ${dir}: ${message}`);
    logger?.warn?.(`failed to read directory ${dir}: ${message}`);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    // Handle symbolic links explicitly to control loop behaviour.
    if (entry.isSymbolicLink()) {
      if (!followSymlinks) continue;
      let real;
      try {
        real = await fs.realpath(full);
      } catch {
        continue;
      }
      try {
        const st = await fs.stat(real);
        const key = `${st.dev}:${st.ino}`;
        if (seenInodes.has(key)) continue;
        seenInodes.add(key);
        if (st.isDirectory()) {
          await walk(real, followSymlinks, seenInodes, out, warnings, logger);
        } else if (st.isFile() && entry.name === 'SKILL.md') {
          out.push(real);
        }
      } catch {
        continue;
      }
      continue;
    }

    if (entry.isDirectory()) {
      await walk(full, followSymlinks, seenInodes, out, warnings, logger);
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      out.push(full);
    }
  }
}

function createFileSkill(
  absSkillMdPath: string,
  metadata: ReturnType<typeof parseSkillFile>['metadata'],
  rawBody: string,
): AgentSkill {
  const skillDir = path.dirname(absSkillMdPath);
  let bodyPromise: Promise<AgentSkillBody> | null = null;

  const skill: AgentSkill = {
    metadata,
    source: 'file',
    skillDir,
    loadBody() {
      if (bodyPromise) return bodyPromise;
      bodyPromise = enumerateReferencedFiles(skillDir, rawBody).then(
        (referencedFiles) => Object.freeze({
          raw: rawBody,
          referencedFiles,
        }),
      );
      return bodyPromise;
    },
    resolveFile(rel: string) {
      return resolveWithin(skillDir, rel);
    },
  };
  return skill;
}

/**
 * Resolve `rel` relative to `baseDir`, rejecting paths that attempt to escape
 * the directory or use absolute paths.
 */
export function resolveWithin(baseDir: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel === '') return null;
  if (path.isAbsolute(rel)) return null;
  if (rel.includes('\0')) return null;
  const normalisedRel = rel.split(/[\\/]+/).join(path.sep);
  const resolved = path.resolve(baseDir, normalisedRel);
  const normalisedBase = path.resolve(baseDir);
  if (resolved === normalisedBase) return null;
  const prefix = normalisedBase + path.sep;
  if (!resolved.startsWith(prefix)) return null;
  return resolved;
}

/**
 * Enumerate the set of files referenced by a SKILL.md body that actually
 * exist on disk. The detection is intentionally conservative: we capture
 * bare relative paths mentioned in markdown links and reference-style tokens.
 */
async function enumerateReferencedFiles(
  skillDir: string,
  body: string,
): Promise<readonly string[]> {
  const candidates = new Set<string>();
  // Markdown link form: [text](path)
  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
  // Back-ticked reference to a file: `path/file.md`
  const tickRe = /`([^`]+\.[A-Za-z0-9]+)`/g;
  // `See FORMS.md`, `read REFERENCE.md` — capture uppercase ref-looking tokens
  const bareRe = /\b([A-Z][A-Za-z0-9_-]*\.[A-Za-z0-9]+)\b/g;

  for (const re of [linkRe, tickRe, bareRe]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const candidate = m[1];
      if (!candidate) continue;
      if (candidate.startsWith('http://') || candidate.startsWith('https://')) continue;
      if (candidate.startsWith('#')) continue;
      if (candidate.startsWith('/')) continue;
      if (candidate.includes('..')) continue;
      candidates.add(candidate);
    }
  }

  const present: string[] = [];
  for (const rel of candidates) {
    const full = resolveWithin(skillDir, rel);
    if (!full) continue;
    try {
      const st = await fs.stat(full);
      if (st.isFile()) present.push(rel);
    } catch {
      // silently drop — only actually-present files are reported
    }
  }
  present.sort();
  return Object.freeze(present);
}
