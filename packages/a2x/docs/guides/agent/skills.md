# Agent Skills (Claude open standard)

A2X supports the open Claude Agent Skills format. A "skill" is a directory
with a `SKILL.md` describing when to use it, plus optional reference files
and scripts. When you point the SDK at a skill root (or hand it inline
skills), the agent automatically:

- Injects each skill's name + description into the system prompt.
- Registers three builtin tools — `load_skill`, `read_skill_file`,
  `run_skill_script` — that the LLM uses to pull the body, read bundled
  files, and run scripts.
- Applies variable substitution (`${A2X_SKILL_DIR}`, `${A2X_SESSION_ID}`,
  `$ARGUMENTS`, `$0`, `$1`, …, plus the `${CLAUDE_*}` aliases for Anthropic
  skill compatibility).

The same skill directory behaves identically under the Anthropic, OpenAI,
and Google providers.

## One-line activation

```ts
import { LlmAgent } from '@a2x/sdk';
import { AnthropicProvider } from '@a2x/sdk/anthropic';

const agent = new LlmAgent({
  name: 'my-agent',
  provider: new AnthropicProvider({ model: 'claude-sonnet-4', apiKey: process.env.ANTHROPIC_API_KEY! }),
  instruction: 'You are an assistant with access to the skills below.',
  skills: { root: '/absolute/path/to/skills' },
});
```

`skills.root` **must be an absolute path**. Use `__dirname` /
`import.meta.url` to derive it so the code stays bundler-neutral:

```ts
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillsRoot = path.resolve(here, '../skills');
```

## Inline skills

Use `defineSkill` when you cannot ship a directory of `.md` files at
runtime (serverless, Next.js bundling, edge runtimes):

```ts
import { defineSkill, LlmAgent } from '@a2x/sdk';

const commitHelper = defineSkill({
  name: 'commit-helper',
  description: 'Generate concise commit messages from staged changes.',
  body: [
    '# commit-helper',
    '',
    '1. Read the staged diff.',
    '2. Produce a conventional commit message.',
  ].join('\n'),
  resources: {
    'FORMAT.md': 'Use type(scope): subject.',
  },
  scripts: {
    // Function-backed scripts run in-process — no child process is spawned.
    'scripts/preview.js': async ({ arguments: argv }) => ({
      stdout: `preview for ${argv.join(' ')}`,
      exitCode: 0,
    }),
  },
});

const agent = new LlmAgent({
  name: 'my-agent',
  provider: /* any provider */,
  instruction: 'x',
  skills: { inline: [commitHelper] },
});
```

Inline skills can coexist with a filesystem root.

## Script execution policy

Scripts run from the skill's `scripts/` directory. Three modes are
supported:

| Mode      | Behaviour                                                            |
| --------- | -------------------------------------------------------------------- |
| `allow`   | Default. Scripts execute immediately; the audit hook runs for logging. |
| `confirm` | Scripts only execute if `onScriptExecute` returns a truthy value.    |
| `deny`    | Script execution is blocked; the audit hook still fires for auditing. |

```ts
skills: {
  root: skillsRoot,
  scriptMode: 'confirm',
  onScriptExecute: async (meta) => {
    console.warn('[audit]', meta.skillName, meta.scriptRelativePath, meta.arguments);
    return await approveWithOperator(meta);
  },
},
```

The hook can also throw — doing so aborts the execution regardless of the
mode, so you can use it as a uniform kill-switch.

## Frontmatter reference

The SDK accepts every frontmatter field used by the open Claude Agent
Skills format. Required fields are `name` and `description`; everything
else is optional. Fields the runtime does not act on (e.g. `model`,
`effort`, `paths`, `context`, `agent`) are preserved on
`AgentSkillMetadata.unknownFields` for audit purposes.

## Related

- See the [Claude Agent Skills open standard](https://github.com/anthropics/skills)
  for the file format.
- `load_skill`, `read_skill_file`, and `run_skill_script` are ordinary
  tools; they flow through the same provider converters as any
  `FunctionTool` you register yourself.
