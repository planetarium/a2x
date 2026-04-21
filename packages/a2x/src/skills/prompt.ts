/**
 * Layer 2: Skill runtime - system-prompt block formatter.
 *
 * Produces a deterministic, provider-agnostic markdown/XML block that
 * `LlmAgent.run()` prepends-or-appends to the resolved user instruction.
 */

import type { SkillRegistry } from './registry.js';

const HEADER = '# Available Agent Skills';
const GUIDE =
  'You have access to the following skills. Use the `load_skill` tool with '
  + 'the exact name to load a skill\'s full instructions before following them.';

/**
 * Format the block. Returns an empty string when no skills are registered so
 * the caller can `concat` unconditionally.
 */
export function formatSystemPromptBlock(registry: SkillRegistry): string {
  if (registry.isEmpty) return '';
  const lines: string[] = [HEADER, '', GUIDE, ''];
  for (const skill of registry.list()) {
    const desc = combineDescription(skill.metadata.description, skill.metadata.whenToUse);
    lines.push(`<skill name="${skill.metadata.name}">`);
    lines.push(desc);
    lines.push('</skill>');
    lines.push('');
  }
  // Drop the trailing blank line to keep output stable.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Combine `description` and optional `when_to_use` into the single line the
 * prompt block presents to the LLM. Callers should render the result
 * verbatim.
 */
export function combineDescription(
  description: string,
  whenToUse: string | undefined,
): string {
  if (!whenToUse) return description;
  const trimmed = description.replace(/\s+$/, '');
  const separator = /[.!?]$/.test(trimmed) ? ' ' : '. ';
  return `${trimmed}${separator}${whenToUse}`.trim();
}

/** Combine an existing systemInstruction with the skill block. */
export function combineSystemInstruction(
  baseInstruction: string,
  registry: SkillRegistry,
): string {
  const block = formatSystemPromptBlock(registry);
  if (block === '') return baseInstruction;
  if (baseInstruction === '') return block;
  return `${baseInstruction}\n\n${block}`;
}
