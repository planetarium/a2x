/**
 * Layer 2: Skill runtime - `read_skill_file` builtin tool.
 *
 * Reads a file under the skill's own directory with strict path-escape
 * protection. For inline skills the in-memory `readInlineAsset` map is used;
 * file skills hit the real filesystem via `fs.readFile`.
 */

import * as fs from 'node:fs/promises';
import { FunctionTool } from '../tool/function-tool.js';
import type { InvocationContext } from '../runner/context.js';
import type { SkillRegistry } from './registry.js';
import { SkillExecutionError } from './errors.js';
import { substitute } from './substitution.js';
import { READ_SKILL_FILE_TOOL_NAME } from './load-skill-tool.js';

const DESCRIPTION =
  'Read the contents of a file bundled inside a registered skill. The file '
  + 'must be inside the skill directory — paths containing ".." or absolute '
  + 'paths are rejected. Any A2X or Claude variables embedded in the file '
  + 'are substituted before the content is returned.';

const SCHEMA = {
  type: 'object',
  properties: {
    skill: {
      type: 'string',
      description: 'Name of the skill whose file you want to read.',
    },
    file: {
      type: 'string',
      description:
        'Path relative to the skill directory (e.g. "FORMS.md" or "resources/schema.json"). Absolute paths and ".." segments are rejected.',
    },
    arguments: {
      type: 'string',
      description:
        'Optional whitespace-separated arguments used to substitute $ARGUMENTS / $0 / $1 ... inside the file.',
    },
  },
  required: ['skill', 'file'],
  additionalProperties: false,
} as const;

export interface ReadSkillFileArgs {
  skill: string;
  file: string;
  arguments?: string;
}

export interface ReadSkillFileResult {
  skill_name: string;
  file: string;
  absolute_path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

export interface ReadSkillFileErrorResult {
  error: string;
  hint?: string;
}

export function createReadSkillFileTool(
  registry: SkillRegistry,
): FunctionTool<ReadSkillFileArgs> {
  return new FunctionTool<ReadSkillFileArgs>({
    name: READ_SKILL_FILE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: SCHEMA,
    async execute(args, context) {
      return executeReadSkillFile(registry, args, context);
    },
  });
}

export async function executeReadSkillFile(
  registry: SkillRegistry,
  args: ReadSkillFileArgs,
  context: InvocationContext,
): Promise<ReadSkillFileResult | ReadSkillFileErrorResult> {
  if (!args || typeof args.skill !== 'string' || typeof args.file !== 'string') {
    return { error: 'parameters "skill" and "file" are required' };
  }
  const skill = registry.get(args.skill);
  if (!skill) {
    return {
      error: `skill "${args.skill}" is not registered`,
      hint: `Use one of: ${registry.names().join(', ') || '(none registered)'}`,
    };
  }

  const resolved = skill.resolveFile(args.file);
  if (!resolved) {
    return {
      error: `file "${args.file}" is not accessible inside skill "${args.skill}"`,
      hint: 'Provide a path relative to the skill directory without ".." or absolute path segments.',
    };
  }

  if (context.signal?.aborted) {
    return { error: 'read_skill_file aborted' };
  }

  let rawText: string;
  let encoding: 'utf8' | 'base64' = 'utf8';
  if (skill.source === 'inline') {
    const buf = skill.readInlineAsset?.(args.file) ?? null;
    if (buf === null) {
      return {
        error: `file "${args.file}" is not bundled in inline skill "${args.skill}"`,
      };
    }
    if (typeof buf === 'string') {
      rawText = buf;
    } else if (isUtf8Decodable(buf)) {
      rawText = buf.toString('utf8');
    } else {
      rawText = buf.toString('base64');
      encoding = 'base64';
    }
  } else {
    try {
      const buf = await fs.readFile(resolved, { signal: context.signal });
      if (isUtf8Decodable(buf)) {
        rawText = buf.toString('utf8');
      } else {
        rawText = buf.toString('base64');
        encoding = 'base64';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SkillExecutionError(
        `failed to read file "${args.file}" in skill "${args.skill}": ${msg}`,
        { source: resolved, cause: err },
      );
    }
  }

  let content = rawText;
  if (encoding === 'utf8') {
    content = substitute(rawText, {
      skill,
      sessionId: context.session.id,
      arguments: typeof args.arguments === 'string' ? args.arguments : '',
      enableClaudeVarCompat: registry.enableClaudeVarCompat,
      logger: registry.logger,
    });
  }

  return {
    skill_name: skill.metadata.name,
    file: args.file,
    absolute_path: resolved,
    content,
    encoding,
  };
}

function isUtf8Decodable(buf: Buffer): boolean {
  // Treat the content as binary if we find NUL bytes or an invalid UTF-8
  // sequence. The heuristic below matches Node's `Buffer#toString('utf8')`
  // replacement behaviour.
  if (buf.includes(0)) return false;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(buf);
    return true;
  } catch {
    return false;
  }
}
