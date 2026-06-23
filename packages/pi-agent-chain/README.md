# @dsshap/pi-agent-chain

**Sequential pipeline orchestrator for [Pi](https://github.com/badlogic/pi-mono)** — runs
opinionated, repeatable multi-agent workflows. The primary agent uses a
`run_chain` tool to kick off a defined sequence; each step's output feeds into
the next as `$INPUT`.

Derived from IndyDevDan's
[pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code) (`extensions/agent-chain.ts`).

## What it does

- Define **chains** in YAML — ordered lists of `(agent, prompt)` steps
- The primary agent calls the `run_chain` tool with a task
- Each step spawns a `pi` subprocess running the named agent with its own
  system prompt, tool allow-list, and persistent session file
- `$INPUT` interpolates the previous step's output; `$ORIGINAL` always refers
  to the user's original task
- A live widget renders the pipeline cards with status (`pending`,
  `running`, `done`, `error`), elapsed time, and the last line of work
- Agents retain context across re-runs within the same Pi session

## Install

```bash
pi install npm:@dsshap/pi-agent-chain
```

Or run without installing:

```bash
pi -e npm:@dsshap/pi-agent-chain
```

## Commands

| Command       | What it does                                                |
| ------------- | ----------------------------------------------------------- |
| `/chain`      | Switch the active chain                                     |
| `/chain-list` | List all available chains                                   |
| `/chain-send` | Send a message or reset command to one or more subagents    |

## Bundled agents

Ship in `agents/` and are auto-discovered:

- **planner** — architecture and implementation planning
- **builder** — implementation and code generation
- **code-reviewer** — code review and quality checks
- **plan-reviewer** — plan critic; challenges and validates plans
- **scout** — fast recon and codebase exploration
- **documenter** — documentation and README generation
- **red-team** — security and adversarial testing
- **bowser** — headless browser automation (requires the
  `playwright-bowser` skill to be installed separately)

## Bundled chains

Defined in `agents/agent-chain.yaml`:

- **plan-build-review** — Plan → Build → Review (the standard dev cycle)
- **plan-reviewer-build-review** — Plan → Critique/Refine → Build → Review
- **plan-build** — Plan → Build (fast two-step)
- **scout-flow** — Scout → Scout → Scout (triple deep recon)
- **plan-review-plan** — Plan → Critique → Revise (iterative planning)
- **full-review** — Scout → Plan → Build → Review (end-to-end)

## Override / customize

User configuration takes precedence over bundled defaults:

- **Chains**: drop a `.pi/agents/agent-chain.yaml` in your project. If
  present, it fully replaces the bundled chain list.
- **Agents**: any `.md` files in `agents/`, `.claude/agents/`, or
  `.pi/agents/` (relative to the project cwd) are loaded; same-name files
  override the bundled versions.

### Chain YAML format

```yaml
my-chain:
  description: "Short summary of the chain"
  steps:
    - agent: planner
      prompt: "Plan: $INPUT"
    - agent: builder
      prompt: "Build this plan:\n\n$INPUT"
    - agent: code-reviewer
      prompt: "Review:\n\n$INPUT\n\nOriginal task: $ORIGINAL"
```

### Agent `.md` frontmatter

```markdown
---
name: my-agent
description: One-line description shown in the chain widget and prompt
tools: read,write,edit,bash,grep,find,ls
model: anthropic/claude-opus-4-7   # optional — see below
---

System prompt body goes here. Be specific about role, constraints, and
output format.
```

#### `model` field (optional)

Per-agent model selection. Supplied as `<provider>/<id>` and passed verbatim
to the spawned `pi --model` flag, so anything the `pi` CLI accepts works:

```yaml
model: anthropic/claude-opus-4-7         # pin a frontier model for review
model: anthropic/claude-sonnet-4-6       # faster/cheaper for routine work
model: openrouter/google/gemini-3-flash-preview
```

**Resolution order** when spawning the subagent (`runAgent`):

1. `agentDef.model` from the .md frontmatter, if set and not `*/*`
2. The orchestrator's currently-active model (`ctx.model.provider/ctx.model.id`)
3. A hardcoded fallback (`openrouter/google/gemini-3-flash-preview`)

The wildcard `model: */*` is treated as "no preference" — it falls through to
the orchestrator's model. Useful when you want to declare the field for
documentation but defer the actual choice to whatever the user is driving Pi
with.

The orchestrator's system prompt catalog displays each agent's resolved
model (or `(inherits orchestrator)`) so the planner knows what it's working
with before launching the chain.

## How it runs each step

Each step spawns:

```
pi --mode json -p --no-extensions \
   --model <provider/id> \
   --tools <agent.tools> \
   --thinking off \
   --append-system-prompt <agent.systemPrompt> \
   --session .pi/agent-sessions/<parent-session-id>/chain-<agent>.json \
   [-c if session exists] \
   <resolved prompt>
```

Subprocesses inherit your env. Subagent session files are scoped by the parent
Pi session id, so different parent sessions/tabs in the same repo do not race
on the same `chain-<agent>.json` files. `/new` naturally starts a fresh
namespace because it creates a new parent session id; `/resume` and `/reload`
reuse the namespace for the active parent session.

## License

MIT. See [LICENSE](./LICENSE) — original work © IndyDevDan, modifications © dsshap.
