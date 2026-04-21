import { defineSkill, type AgentSkill } from "@a2x/sdk";

/**
 * An inline skill — no filesystem files are involved. This demonstrates that
 * skills can be authored entirely in TypeScript when the deployment
 * environment cannot ship markdown alongside the JS bundle.
 */
export const mathHelperSkill: AgentSkill = defineSkill({
  name: "math-helper",
  description:
    "Evaluate short arithmetic expressions step-by-step. Use when the user asks for arithmetic such as '23 * 47', 'what is 312 + 489 - 76', or anything that looks like a numeric calculation.",
  body: `# Math Helper

Perform the arithmetic the user requested. Always show at least one
intermediate step before stating the final numeric answer so the user can spot
a mistake if they disagree with the result.

Format the final answer as a single line:

\`\`\`
Result: <number>
\`\`\`

Do NOT invoke tools for this — the calculation is performed entirely by you.`,
});
