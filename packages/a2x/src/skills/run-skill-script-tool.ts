/**
 * Layer 2: Skill runtime - `run_skill_script` builtin tool.
 *
 * Executes a script bundled inside a skill. Policy-aware (`allow` / `confirm`
 * / `deny`), audit-hook aware (`onScriptExecute`), and strictly sandboxed to
 * the skill's `scripts/` directory.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FunctionTool } from '../tool/function-tool.js';
import type { InvocationContext } from '../runner/context.js';
import type { SkillRegistry } from './registry.js';
import { SkillExecutionError } from './errors.js';
import { RUN_SKILL_SCRIPT_TOOL_NAME } from './load-skill-tool.js';
import { getInlineScriptHandler } from './define-skill.js';
import type { AgentSkill, SkillScriptExecutionMeta } from './types.js';

const DESCRIPTION =
  'Run a script bundled inside a registered skill. The script must live under '
  + 'the skill\'s "scripts/" directory. Returns stdout, stderr, and the exit '
  + 'code. The host may reject the call if the script-execution policy is '
  + 'configured to confirm or deny.';

const SCHEMA = {
  type: 'object',
  properties: {
    skill: {
      type: 'string',
      description: 'Name of the skill that owns the script.',
    },
    script: {
      type: 'string',
      description:
        'Path to the script, relative to the skill directory. Must start with "scripts/" and must not contain ".." or absolute-path segments.',
    },
    arguments: {
      type: 'array',
      items: { type: 'string' },
      description: 'Positional arguments passed verbatim to the script.',
      default: [],
    },
  },
  required: ['skill', 'script'],
  additionalProperties: false,
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 1_048_576; // 1 MiB
const PASSTHROUGH_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'TZ'] as const;

export interface RunSkillScriptArgs {
  skill: string;
  script: string;
  arguments?: readonly string[];
}

export interface RunSkillScriptResult {
  skill: string;
  script: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted?: boolean;
  truncated?: boolean;
}

export interface RunSkillScriptErrorResult {
  error: string;
  hint?: string;
}

export function createRunSkillScriptTool(
  registry: SkillRegistry,
): FunctionTool<RunSkillScriptArgs> {
  return new FunctionTool<RunSkillScriptArgs>({
    name: RUN_SKILL_SCRIPT_TOOL_NAME,
    description: DESCRIPTION,
    parameters: SCHEMA,
    async execute(args, context) {
      return executeRunSkillScript(registry, args, context);
    },
  });
}

export async function executeRunSkillScript(
  registry: SkillRegistry,
  args: RunSkillScriptArgs,
  context: InvocationContext,
): Promise<RunSkillScriptResult | RunSkillScriptErrorResult> {
  if (!args || typeof args.skill !== 'string' || typeof args.script !== 'string') {
    return { error: 'parameters "skill" and "script" are required' };
  }
  const skill = registry.get(args.skill);
  if (!skill) {
    return {
      error: `skill "${args.skill}" is not registered`,
      hint: `Use one of: ${registry.names().join(', ') || '(none registered)'}`,
    };
  }

  const rel = normaliseScriptKey(args.script);
  if (!rel) {
    return {
      error: `script "${args.script}" is invalid`,
      hint: 'Scripts must be relative paths under "scripts/" with no absolute-path or ".." segments.',
    };
  }
  if (!rel.startsWith('scripts/')) {
    return {
      error: `script "${args.script}" must be under "scripts/"`,
      hint: 'Only scripts under the skill\'s "scripts/" directory can be executed.',
    };
  }

  const argsList = Array.isArray(args.arguments)
    ? args.arguments.map((a) => (typeof a === 'string' ? a : String(a)))
    : [];

  const meta: SkillScriptExecutionMeta = Object.freeze({
    skillName: skill.metadata.name,
    scriptPath: skill.source === 'file'
      ? path.join(skill.skillDir, ...rel.split('/'))
      : `${skill.skillDir}/${rel}`,
    scriptRelativePath: rel,
    arguments: Object.freeze([...argsList]),
    sessionId: context.session.id,
    agentName: context.agentName,
    mode: registry.scriptMode,
    declaredAllowedTools: skill.metadata.allowedTools,
  });

  // Audit hook runs even in deny mode so that auditors see the attempt.
  if (registry.onScriptExecute) {
    try {
      const hookResult = await registry.onScriptExecute(meta);
      if (registry.scriptMode === 'confirm' && !hookResult) {
        return {
          error: 'script execution rejected by onScriptExecute hook',
          hint: 'The configured confirm-hook returned a falsy value.',
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        error: `script execution blocked: ${msg}`,
        hint: 'The onScriptExecute hook threw an error.',
      };
    }
  } else if (registry.scriptMode === 'confirm') {
    return {
      error: 'script execution requires an onScriptExecute hook in "confirm" mode',
      hint: 'Register onScriptExecute when using scriptMode "confirm".',
    };
  }

  if (registry.scriptMode === 'deny') {
    return {
      error: 'script execution is disabled by configuration',
      hint: 'The SDK is configured with scriptMode: "deny".',
    };
  }

  if (context.signal?.aborted) {
    return { error: 'run_skill_script aborted' };
  }

  // Inline function-backed scripts bypass the filesystem entirely.
  const inlineHandler = getInlineScriptHandler(skill, rel);
  if (inlineHandler) {
    try {
      const res = await inlineHandler({
        arguments: argsList,
        context,
        skill,
      });
      return {
        skill: skill.metadata.name,
        script: rel,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
        exitCode: res.exitCode ?? 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `inline script failed: ${msg}` };
    }
  }

  if (skill.source === 'inline') {
    return {
      error: `script "${args.script}" is not executable in inline skill "${args.skill}"`,
      hint: 'Register an inline script function via defineSkill({ scripts: { ... } }).',
    };
  }

  // File-backed skills — validate and spawn.
  const abs = resolveScriptPath(skill, rel);
  if (!abs) {
    return {
      error: `script "${args.script}" escapes the skill directory`,
      hint: 'Provide a path relative to the skill\'s "scripts/" directory without ".." or absolute-path segments.',
    };
  }

  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) {
      return { error: `script "${args.script}" is not a regular file` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `script "${args.script}" is not accessible: ${msg}` };
  }

  return await spawnScript(abs, skill, argsList, context, registry);
}

function normaliseScriptKey(raw: string): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  if (raw.includes('\0')) return null;
  const normalised = raw.split('\\').join('/');
  if (normalised.startsWith('/')) return null;
  const segments = normalised.split('/');
  for (const seg of segments) {
    if (seg === '..') return null;
  }
  return normalised;
}

function resolveScriptPath(skill: AgentSkill, rel: string): string | null {
  const resolved = skill.resolveFile(rel);
  if (!resolved) return null;
  if (skill.source !== 'file') return null;
  return resolved;
}

async function spawnScript(
  abs: string,
  skill: AgentSkill,
  argsList: readonly string[],
  context: InvocationContext,
  registry: SkillRegistry,
): Promise<RunSkillScriptResult | RunSkillScriptErrorResult> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  env.A2X_SKILL_DIR = skill.skillDir;
  env.A2X_SESSION_ID = context.session.id;
  if (registry.enableClaudeVarCompat) {
    env.CLAUDE_SKILL_DIR = skill.skillDir;
    env.CLAUDE_SESSION_ID = context.session.id;
  }

  const { command, commandArgs } = await determineLauncher(abs);

  return await new Promise<RunSkillScriptResult | RunSkillScriptErrorResult>(
    (resolve) => {
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let aborted = false;

      let child;
      try {
        child = spawn(command, [...commandArgs, ...argsList], {
          cwd: skill.skillDir,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resolve({ error: `failed to spawn script: ${msg}` });
        return;
      }

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, DEFAULT_TIMEOUT_MS);

      const onAbort = () => {
        aborted = true;
        child.kill('SIGTERM');
      };
      if (context.signal) {
        if (context.signal.aborted) onAbort();
        else context.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= MAX_BUFFER_BYTES) {
          stdout += chunk.toString('utf8');
        } else if (!truncated) {
          const remaining = MAX_BUFFER_BYTES - (stdoutBytes - chunk.length);
          if (remaining > 0) stdout += chunk.subarray(0, remaining).toString('utf8');
          truncated = true;
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_BUFFER_BYTES) {
          stderr += chunk.toString('utf8');
        } else if (!truncated) {
          const remaining = MAX_BUFFER_BYTES - (stderrBytes - chunk.length);
          if (remaining > 0) stderr += chunk.subarray(0, remaining).toString('utf8');
          truncated = true;
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (context.signal) context.signal.removeEventListener('abort', onAbort);
        resolve({ error: `script spawn error: ${err.message}` });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (context.signal) context.signal.removeEventListener('abort', onAbort);
        const exitCode = typeof code === 'number' ? code : signal ? -1 : 0;
        resolve({
          skill: skill.metadata.name,
          script: path.relative(skill.skillDir, abs).split(path.sep).join('/'),
          stdout,
          stderr,
          exitCode,
          aborted: aborted || signal === 'SIGTERM' ? aborted || undefined : undefined,
          truncated: truncated || undefined,
        });
      });
    },
  );
}

/**
 * Pick a launcher based on the script's shebang line (if any) or its
 * extension. Returns `{ command: abs, commandArgs: [] }` when the script is
 * executable directly.
 */
async function determineLauncher(abs: string): Promise<{
  command: string;
  commandArgs: string[];
}> {
  try {
    const fd = await fs.open(abs, 'r');
    try {
      const { buffer, bytesRead } = await fd.read({ buffer: Buffer.alloc(256), position: 0 });
      const head = buffer.subarray(0, bytesRead).toString('utf8');
      if (head.startsWith('#!')) {
        const line = head.split(/\r?\n/)[0].slice(2).trim();
        if (line) {
          const parts = line.split(/\s+/);
          const command = parts[0];
          const commandArgs = parts.slice(1);
          // The shebang interpreter receives the script path as its final argv.
          commandArgs.push(abs);
          return { command, commandArgs };
        }
      }
    } finally {
      await fd.close();
    }
  } catch {
    // ignore — we'll fall through to extension-based logic
  }

  const ext = path.extname(abs).toLowerCase();
  switch (ext) {
    case '.sh':
      return { command: 'bash', commandArgs: [abs] };
    case '.py':
      return { command: 'python3', commandArgs: [abs] };
    case '.js':
    case '.mjs':
      return { command: 'node', commandArgs: [abs] };
    default:
      return { command: abs, commandArgs: [] };
  }
}

// Re-export for tests / host visibility.
export { SkillExecutionError };
