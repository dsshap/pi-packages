# @dsshap/pi-subagent-flags

> **Not a Pi extension.** This package is a small npm library consumed by Pi extensions that spawn `pi` as a subprocess. End users do not install or configure it directly — it is pulled in automatically as a transitive dependency of the consuming extension.

A shared helper for [Pi](https://github.com/badlogic/pi-mono) extensions that spawn `pi` as a subprocess to run sub-agents. Lets local users splice extra `pi` flags into every sub-agent spawn from a named extension by dropping a `subagent-flags.json` config on disk — without forking or rebuilding the extension.

## Audience

This README is for **extension authors** who want to add a local-config hook to their own Pi extension. If you are an end user trying to configure brand-leak protection in `@dsshap/pi-pi-experts` or `@dsshap/pi-agent-chain`, see those extensions' READMEs — you only need to create `~/.pi/agent/subagent-flags.json`.

Consumers in this repo:

- [`@dsshap/pi-pi-experts`](../pi-pi-experts/)
- [`@dsshap/pi-agent-chain`](../pi-agent-chain/)

## Why it exists

The canonical use case is **brand-string rewriting** for Anthropic Claude Code OAuth. Pi's default coding-assistant prompt contains phrases (`pi itself`, `pi packages`, `pi .md files`) that the OAuth endpoint rejects with HTTP 400. A companion extension ([`pi-claude-code-use`](https://github.com/benvargas/pi-packages/tree/main/packages/pi-claude-code-use)) rewrites them in flight, but only runs in the process where it's loaded — and sub-agent subprocesses are launched with `--no-extensions` for isolation.

The fix: an end user drops a `subagent-flags.json` config declaring `-e <path-to-pi-claude-code-use>` for each extension that spawns sub-agents. The extension uses this library to read the config and splice those args into every `spawn("pi", ...)` call. The protection extension loads in the child via `pi`'s explicit `-e` mechanism (which is allowed even alongside `--no-extensions`).

Public users with no config file see no behavior change.

## Adding to a new Pi extension

If you are writing a Pi extension that spawns sub-agents and want to give your users this hook, depend on this package and call `loadSubagentExtraArgs` at spawn time.

### 1. Declare the dependency

In your extension's `package.json`:

```jsonc
{
  "dependencies": {
    "@dsshap/pi-subagent-flags": "^1.0.0"
  }
}
```

### 2. Splice into your spawn args

```ts
import { spawn } from "node:child_process";
import { loadSubagentExtraArgs } from "@dsshap/pi-subagent-flags";

const EXTENSION_NAME = "your-extension-short-name";

// inside your spawn helper:
const args = [
  "--mode", "json",
  "-p",
  "--no-extensions",
  "--model", `${ctx.model.provider}/${ctx.model.id}`,
  "--tools", agentDef.tools,
  "--thinking", "off",
  "--append-system-prompt", agentDef.systemPrompt,
  ...loadSubagentExtraArgs(EXTENSION_NAME, ctx.cwd),
  task,
];
spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
```

The first argument to `loadSubagentExtraArgs` is the key your users will set in their `subagent-flags.json`. Pick a stable short name — usually the package short name without the npm scope (e.g. `"pi-pi-experts"`, not `"@dsshap/pi-pi-experts"`).

### 3. Document the hook in your extension's README

Tell your users which key to set, and point them at the config-file layout below.

## Config file (user side)

Two locations are checked, in order; project overrides global per top-level key:

```
~/.pi/agent/subagent-flags.json      (global)
<cwd>/.pi/subagent-flags.json        (project)
```

Schema:

```jsonc
{
  // Top-level keys = exact extension short name (as passed to loadSubagentExtraArgs).
  "pi-pi-experts": {
    "extraArgs": [
      "-e",
      "/Users/dsshap/apps/ben-vargas-pi-packages/packages/pi-claude-code-use"
    ]
  },
  "pi-agent-chain": {
    "extraArgs": [
      "-e",
      "/Users/dsshap/apps/ben-vargas-pi-packages/packages/pi-claude-code-use"
    ]
  }
}
```

**Rules:**

- Top-level merge is shallow: project's entry for a given extension fully replaces global's entry for the same extension.
- `extraArgs` is a flat string array — exactly what gets spliced into the `pi` command.
- Paths should be absolute. No `~` expansion.
- Anything malformed (bad JSON, wrong shape, missing keys) is silently ignored and the function returns `[]`.

## API

```ts
export interface SubagentFlags {
  extraArgs?: string[];
}

/** Pure resolver — testable in isolation. */
export function resolveSubagentExtras(
  rawConfigs: ReadonlyArray<string | undefined>,
  extensionName: string,
): string[];

/** Reads ~/.pi/agent/subagent-flags.json + <cwd>/.pi/subagent-flags.json. */
export function loadSubagentExtraArgs(
  extensionName: string,
  cwd: string,
): string[];
```

`resolveSubagentExtras` is the testable pure core — pass it an array of raw JSON strings (or `undefined` for missing files) and it returns the merged result. `loadSubagentExtraArgs` is the convenience wrapper that does the filesystem reads.

## License

MIT. See [LICENSE](./LICENSE).
