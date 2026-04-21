import path from "node:path";
import {
  A2XAgent,
  AgentExecutor,
  DefaultRequestHandler,
  InMemoryRunner,
  InMemoryTaskStore,
  LlmAgent,
  SkillScriptExecutionMeta,
  StreamingMode,
} from "@a2x/sdk";
import { AnthropicProvider } from "@a2x/sdk/anthropic";
import { mathHelperSkill } from "./inline-skills";

const SKILLS_ROOT = path.resolve(process.cwd(), "skills");

const agent = new LlmAgent({
  name: "skill_demo_agent",
  provider: new AnthropicProvider({
    model: "claude-sonnet-4-20250514",
    apiKey: process.env.ANTHROPIC_API_KEY!,
  }),
  description:
    "Demo agent showcasing the Claude Agent Skills runtime integrated into @a2x/sdk.",
  instruction: [
    "You are a demo agent for the @a2x/sdk skills runtime.",
    "",
    "Always respond in the same language the user wrote their latest message in.",
    "This applies to your own prose, to tool-call narration, and to any values",
    "inside a skill's formatted output that are not fixed template tokens",
    "(e.g. translate the 'condition' or 'wind description' fields but keep",
    "numeric fields and structural separators as specified by the skill).",
    "",
    "You have access to several skills:",
    "- weather-report (file-backed; consults a reference file and runs a stub forecast script)",
    "- recipe-suggest (file-backed; consults a formatting reference)",
    "- math-helper (inline skill)",
    "",
    "Use the load_skill tool to pull in a skill's instructions when it is",
    "relevant to the user's question, then follow the procedure in the loaded",
    "body. Keep responses concise.",
  ].join("\n"),
  skills: {
    root: SKILLS_ROOT,
    inline: [mathHelperSkill],
    scriptMode: "allow",
    onScriptExecute: (meta: SkillScriptExecutionMeta) => {
      console.log(
        `[skill-audit] skill=${meta.skillName} script=${meta.scriptRelativePath} args=${JSON.stringify(
          meta.arguments,
        )} mode=${meta.mode}`,
      );
      return true;
    },
  },
});

const runner = new InMemoryRunner({ agent, appName: "sample-nextjs-skill" });

const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});

const taskStore = new InMemoryTaskStore();

export const a2xAgent = new A2XAgent({
  taskStore,
  executor,
  protocolVersion: "1.0",
})
  .setDefaultUrl("http://localhost:3000/api/a2a")
  .addSkill({
    id: "skill-runtime-demo",
    name: "Skill Runtime Demo",
    description:
      "Ask about the weather in a city, suggest a recipe from ingredients, or do a quick calculation to trigger a bundled skill.",
    tags: ["demo", "skills"],
  })
  .setCapabilities({ streaming: true });

export const handler = new DefaultRequestHandler(a2xAgent);
