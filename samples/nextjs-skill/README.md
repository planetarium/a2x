# A2X Skills Demo (Next.js)

End-to-end sample that exercises the **Claude Agent Skills runtime** integrated
into `@a2x/sdk`. Three skills are wired in so you can watch the runtime load
metadata lazily, pull bodies via `load_skill`, read reference files, and
execute bundled scripts.

## Skills included

| Name            | Kind          | Exercises                                                   |
| --------------- | ------------- | ----------------------------------------------------------- |
| `weather-report` | file-backed   | `load_skill` → `read_skill_file(REFERENCE.md)` → `run_skill_script(scripts/forecast.sh)` |
| `recipe-suggest` | file-backed   | `load_skill` → `read_skill_file(FORMS.md)`                  |
| `math-helper`    | inline        | `defineSkill(...)` injected via `LlmAgent.skills.inline`    |

All three are registered on a single `LlmAgent` via one option:

```ts
new LlmAgent({
  // ...
  skills: {
    root: path.resolve(process.cwd(), "skills"),
    inline: [mathHelperSkill],
    scriptMode: "allow",
    onScriptExecute: (meta) => { /* audit log */ return true; },
  },
});
```

## Prerequisites

- Node.js ≥ 20
- pnpm (workspace-aware install)
- An Anthropic API key

## Install and run

From the **repo root**:

```bash
# 1. Install workspace deps (samples/nextjs-skill is part of the workspace)
pnpm install

# 2. Build the SDK so the sample resolves `@a2x/sdk` from dist
pnpm -F @a2x/sdk build

# 3. Configure the key
cp samples/nextjs-skill/.env.example samples/nextjs-skill/.env.local
$EDITOR samples/nextjs-skill/.env.local    # set ANTHROPIC_API_KEY

# 4. Start the dev server
pnpm -F sample-nextjs-skill dev
```

Then open <http://localhost:3000>.

> The sample uses `@a2x/sdk: workspace:*`, so changes to the SDK source are
> picked up after re-running `pnpm -F @a2x/sdk build`. Next.js will reload the
> new dist on its next request.

## Try it

The home page has four preset prompts plus a free-form input:

| Prompt                                                    | Expected behaviour                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `What's the weather in Seoul?`                            | `weather-report` loads → model reads `REFERENCE.md` → runs `scripts/forecast.sh Seoul` → formatted reply   |
| `I have chicken, rice, garlic, and soy sauce...`          | `recipe-suggest` loads → reads `FORMS.md` → emits recipes in the required format                           |
| `What is 347 * 29 + 128?`                                 | `math-helper` (inline) loads → answers with step + `Result: <n>`                                           |
| `Hi, who are you?`                                        | No skill is loaded — baseline response                                                                     |

Toggle **Show raw** to see the full JSON-RPC response.

## What to watch on the server

Run the dev server with the terminal visible. Each time a script is executed
you will see an **audit line** like:

```
[skill-audit] skill=weather-report script=scripts/forecast.sh args=["Seoul"] mode=allow
```

This is printed by the `onScriptExecute` hook declared in
`src/lib/a2x-setup.ts`. Flipping `scriptMode` to `"confirm"` and returning
`false` from the hook will block execution while still emitting the audit log.

## Layout

```
samples/nextjs-skill/
├── skills/                      # root scanned by the runtime
│   ├── weather-report/
│   │   ├── SKILL.md
│   │   ├── REFERENCE.md
│   │   └── scripts/forecast.sh
│   └── recipe-suggest/
│       ├── SKILL.md
│       └── FORMS.md
└── src/
    ├── app/
    │   ├── api/a2a/route.ts     # POST JSON-RPC 2.0 endpoint
    │   ├── .well-known/...      # agent card
    │   └── page.tsx             # browser UI
    └── lib/
        ├── a2x-setup.ts         # LlmAgent + skills config
        └── inline-skills.ts     # defineSkill(math-helper)
```

## Adding your own skill

**File-backed**: drop a new directory under `skills/` with a `SKILL.md`
containing YAML frontmatter and a markdown body. Restart the dev server so
the runtime rescans.

**Inline**: add another `defineSkill({ ... })` export in `src/lib/inline-skills.ts`
and push it into the `inline: [...]` array in `src/lib/a2x-setup.ts`.

## Script execution modes

```ts
skills: {
  scriptMode: "confirm",               // instead of "allow"
  onScriptExecute: async (meta) => {
    // Return true to allow, false to block. Logged either way.
    return meta.arguments.every((a) => !a.includes(";"));
  },
}
```

Set to `"deny"` to turn off the `run_skill_script` tool entirely while keeping
the rest of the runtime active.

## Endpoints

- `POST /api/a2a` — JSON-RPC 2.0 (`message/send`, `message/stream`, `tasks/*`)
- `GET /.well-known/agent.json` — Agent Card (discovery)
- `GET /.well-known/agent-card.json` — mirror of the above
