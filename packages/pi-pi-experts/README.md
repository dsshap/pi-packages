# @dsshap/pi-pi-experts

**Pi Pi** — a meta-agent that builds Pi agents.

Pi Pi turns your Pi session into a coordinated research-and-build workflow. A team of nine domain-specific experts (extensions, themes, skills, settings, TUI, CLI, prompts, agents, keybindings) run **in parallel** as concurrent `pi` subprocesses to gather fresh documentation, then Pi Pi synthesizes their findings and writes the actual files for you.

## Origin & Credits

This package is a packaged, npm-installable derivative of the **Pi Pi** meta-agent originally created by **[IndyDevDan](https://github.com/disler)** as part of the [pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code) project — a showcase of customized Pi Coding Agent harnesses.

- **Original source**: [`extensions/pi-pi.ts`](https://github.com/disler/pi-vs-claude-code/blob/main/extensions/pi-pi.ts) and [`.pi/agents/pi-pi/`](https://github.com/disler/pi-vs-claude-code/tree/main/.pi/agents/pi-pi)
- **Video walkthrough**: [Pi Coding Agent: The Only Claude Code Competitor](https://youtu.be/f8cfH5XX-XU)
- **License**: MIT (both upstream and this fork) — see [LICENSE](./LICENSE)

All nine bundled expert `*.md` personas in `agents/` are byte-identical to the upstream originals. This package adds: an npm-installable structure, a `pi` manifest in `package.json`, eager (factory-time) initialization of the expert registry (so the tool's `execute` closure works the moment `registerTool` returns, including under jiti capture shims), and a `--system-prompt` (replace) rather than `--append-system-prompt` (prepend) handoff to expert subprocesses to avoid an OAuth identity-check failure on the Claude Code subscription auth path.

If you find this package useful, please star and credit the [upstream project](https://github.com/disler/pi-vs-claude-code).

## Features

- **`query_experts` tool** — fire off many experts at once; each returns documentation excerpts, code patterns, and implementation guidance.
- **Live dashboard widget** — colored grid showing each expert's status (idle / researching / done / error), elapsed time, query count, and latest output line.
- **Custom footer** — model, expert activity, and context usage bar.
- **`/experts` command** — list available experts and their status.
- **`/experts-grid <1-5>`** command — adjust dashboard column count.
- **Bundled agent personas** — nine `*.md` expert definitions ship with the package under `agents/`.

## Install

```bash
pi install npm:@dsshap/pi-pi-experts
```

Or as part of the monorepo:

```bash
pi install git:github.com/dsshap/pi-packages
```

Try without installing:

```bash
cd packages/pi-pi-experts
pi -e .
```

## Usage

Start a Pi session with the extension loaded and ask Pi Pi to build something:

> Build me an extension that adds a `/standup` command which summarizes today's git commits.

Pi Pi will:

1. Query the relevant experts (ext-expert, cli-expert, etc.) in parallel.
2. Synthesize their research into a plan.
3. Write the actual extension file using its write/edit tools.

### Commands

| Command | Description |
|---|---|
| `/experts` | List loaded experts and their status |
| `/experts-grid N` | Set dashboard grid columns (1–5, default 3) |

## How it works

On `session_start`, the extension reads every `*.md` file in its bundled `agents/` directory (except `pi-orchestrator.md`), parses the YAML frontmatter (`name`, `description`, `tools`), and registers each as an expert. The orchestrator system prompt is injected via `before_agent_start` using `pi-orchestrator.md` as a template with `{{EXPERT_COUNT}}`, `{{EXPERT_NAMES}}`, and `{{EXPERT_CATALOG}}` placeholders.

When the LLM calls `query_experts`, each query is spawned as a separate `pi -p --no-session --no-extensions --mode json` subprocess with the expert's `tools` and `systemPrompt` applied. All subprocesses run concurrently via `Promise.allSettled`, and streaming output updates the dashboard widget in real time.

## Customizing experts

To add or modify an expert, edit `agents/<name>.md` with this frontmatter:

```markdown
---
name: my-expert
description: One-line description shown in the expert catalog
tools: read,grep,find,ls,bash
---

System prompt for the expert here. This is what the subprocess receives
as its `--system-prompt` (replacing pi's default coding-assistant prompt).
```

Drop the file in `agents/` and reload Pi.

## License

MIT — see [LICENSE](./LICENSE).

Copyright (c) 2025 dsshap. Portions copyright (c) 2026 [IndyDevDan](https://github.com/disler), originally published in [pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code) under the MIT License.
