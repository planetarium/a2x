/**
 * Layer 2: Skill runtime - `load_skill` builtin tool.
 *
 * Exposed as a plain `FunctionTool` so it flows through the existing
 * provider-agnostic tool converters without any special casing.
 */

import { FunctionTool } from '../tool/function-tool.js';
import type { InvocationContext } from '../runner/context.js';
import type { SkillRegistry } from './registry.js';
import { substitute } from './substitution.js';

export const LOAD_SKILL_TOOL_NAME = 'load_skill';
export const READ_SKILL_FILE_TOOL_NAME = 'read_skill_file';
export const RUN_SKILL_SCRIPT_TOOL_NAME = 'run_skill_script';

const LOAD_SKILL_DESCRIPTION =
  'Load the full instructions (body) of a registered Agent Skill. '
  + 'Use this when a skill listed in the "Available Agent Skills" section '
  + 'of the system prompt appears relevant to the current user request. '
  + 'Returns the skill body with runtime variables already substituted, its '
  + 'skill directory, and a list of bundled files you can inspect with '
  + `${READ_SKILL_FILE_TOOL_NAME} or run with ${RUN_SKILL_SCRIPT_TOOL_NAME}.`;

const LOAD_SKILL_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        'Name of the skill to load. Must match an entry from the "Available Agent Skills" system-prompt section.',
    },
    arguments: {
      type: 'string',
      description:
        'Whitespace-separated arguments. Used to substitute $ARGUMENTS, $0, $1, ... tokens inside the skill body. Optional.',
    },
  },
  required: ['name'],
  additionalProperties: false,
} as const;

export interface LoadSkillArgs {
  name: string;
  arguments?: string;
}

export interface LoadSkillResult {
  skill_name: string;
  skill_dir: string;
  body: string;
  referenced_files: readonly string[];
  allowed_tools_hint?: readonly string[];
}

export interface LoadSkillErrorResult {
  error: string;
  hint?: string;
  available?: readonly string[];
}

/** Create the `load_skill` FunctionTool bound to the provided registry. */
export function createLoadSkillTool(registry: SkillRegistry): FunctionTool<LoadSkillArgs> {
  return new FunctionTool<LoadSkillArgs>({
    name: LOAD_SKILL_TOOL_NAME,
    description: LOAD_SKILL_DESCRIPTION,
    parameters: LOAD_SKILL_SCHEMA,
    async execute(args, context) {
      return executeLoadSkill(registry, args, context);
    },
  });
}

export async function executeLoadSkill(
  registry: SkillRegistry,
  args: LoadSkillArgs,
  context: InvocationContext,
): Promise<LoadSkillResult | LoadSkillErrorResult> {
  if (!args || typeof args.name !== 'string' || args.name === '') {
    return {
      error: 'parameter "name" is required',
      hint: `Use one of: ${registry.names().join(', ') || '(none registered)'}`,
      available: registry.names(),
    };
  }
  const skill = registry.get(args.name);
  if (!skill) {
    return {
      error: `skill "${args.name}" is not registered`,
      hint: `Use one of: ${registry.names().join(', ') || '(none registered)'}`,
      available: registry.names(),
    };
  }

  if (context.signal?.aborted) {
    return { error: 'load_skill aborted' };
  }

  const body = await registry.loadBody(args.name);
  const substituted = substitute(body.raw, {
    skill,
    sessionId: context.session.id,
    arguments: typeof args.arguments === 'string' ? args.arguments : '',
    enableClaudeVarCompat: registry.enableClaudeVarCompat,
    logger: registry.logger,
  });

  return {
    skill_name: skill.metadata.name,
    skill_dir: skill.skillDir,
    body: substituted,
    referenced_files: body.referencedFiles,
    allowed_tools_hint: skill.metadata.allowedTools,
  };
}
