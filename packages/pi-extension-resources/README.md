# @dsshap/pi-extension-resources

Two features for working with Pi extension packages that ship more than just code:

1. **Auto-load companion `prompts/` and `skills/`** that live alongside any extension Pi has loaded — no config.
2. **Load extensions by short name** with `--with pi-experts,agent-chain`, resolved from a config file.

Most Pi extension packages ship companion resources next to their code:

```
my-extension/
  package.json
  extensions/index.ts
  prompts/*.md             ← would normally NOT be loaded
  skills/<name>/SKILL.md   ← would normally NOT be loaded
```

Pi's default resource loader only scans `~/.pi/agent/{prompts,skills}/` and `.pi/{prompts,skills}/`. This extension closes that gap.

## Install

```bash
pi install npm:@dsshap/pi-extension-resources
```

Or as part of the monorepo:

```bash
pi install git:github.com/dsshap/pi-packages
```

Try without installing:

```bash
cd packages/pi-extension-resources
pi -e .
```

---

## Feature 1 — auto-load companion prompts & skills

**Zero config.** On every `resources_discover` event (session start + `/reload`), this extension:

1. Inspects every loaded tool and slash command via `pi.getAllTools()` / `pi.getCommands()`.
2. Walks each one's `sourceInfo.baseDir` up to the enclosing `package.json` directory.
3. For each unique package root, contributes `prompts/` and `skills/` subfolders to Pi's resource scanners if they exist on disk.
4. Built-in / SDK tools are skipped.

Works for extensions loaded any way: `pi -e <path>`, auto-discovery in `~/.pi/agent/extensions/` and `.pi/extensions/`, `extensions: [...]` in `settings.json`, `packages: [...]` in `settings.json`.

Example:

```bash
pi -e packages/pi-pi-experts -e packages/pi-agent-chain
```

On session start you'll see:

```
[ext-resources] auto-loaded companion resources from 2 extension(s):
  • pi-pi-experts [prompts + skills]
  • pi-agent-chain [skills]
```

Quiet on `/reload`.

### Conventions required

- Companion folders must be named exactly **`prompts`** and **`skills`** at the package root (same level as `package.json`). Other names are ignored.
- An extension that registers neither tools nor commands (purely event-hook based) won't be detected — but those rarely ship companion resources anyway.

---

## Feature 2 — load extensions by short name (`--with`)

Pass `--with <names>` to load extensions by their folder name, resolved from a config file rather than a full path.

```bash
pi -e packages/pi-extension-resources --with pi-experts,agent-chain
```

becomes the equivalent of:

```bash
pi -e packages/pi-extension-resources -e <path-to-pi-pi-experts> -e <path-to-pi-agent-chain>
```

On startup:

```
[ext-resources] loaded via --with: pi-pi-experts, pi-agent-chain
```

### Syntax

`--with` accepts comma-separated names and may be repeated. `PI_WITH` is an env-var equivalent.

```bash
# All equivalent
pi -e . --with pi-experts,agent-chain
pi -e . --with pi-experts --with agent-chain
PI_WITH=pi-experts,agent-chain pi -e .
```

Argv names are processed first, then `PI_WITH` (deduped).

### Config file

Default location: `~/.pi/agent/extensions/pi-extension-resources.json`

On first run with `--with`, this file is auto-created with an empty `locations` list:

```json
{ "locations": [] }
```

**You must populate it** with one or more directories that contain extension package folders (one-level scan):

```json
{
  "locations": [
    "~/apps/pi-packages/packages",
    "~/apps/ben-vargas-pi-packages/packages"
  ]
}
```

Each `location` is scanned for one-level subdirectories (skipping `.dotfiles` and `node_modules`). First location wins on duplicate folder names. `~/...` expansion is supported.

Override the config path (e.g. for tests) with `PI_EXTENSION_RESOURCES_CONFIG`:

```bash
PI_EXTENSION_RESOURCES_CONFIG=/tmp/my-config.json pi -e . --with foo
```

### Name resolution

Three tiers, first tier with a single match wins:

| Tier | Rule | Example |
|---|---|---|
| 1 | Exact folder name | `pi-pi-experts` → `pi-pi-experts` |
| 2 | Case-insensitive exact | `PI-Pi-Experts` → `pi-pi-experts` |
| 3 | Case-insensitive substring | `experts` → `pi-pi-experts` |

Ambiguous matches (more than one in a tier) and unmatched names are reported as warnings on startup; other resolved names still load.

### How it works under the hood

`--with` resolution and loading happens **inside this extension's factory**, before Pi's session bootstrap completes. Each resolved bundle is loaded via [`jiti`](https://github.com/unjs/jiti) and its default-exported factory is invoked with a passthrough `ExtensionAPI` shim — so its `registerTool`, `registerCommand`, `on(...)`, etc. calls land in Pi's live runtime exactly as if Pi had loaded them itself. No symlinks, no `/reload`, no settings.json mutation.

This pattern is established by [`@benvargas/pi-claude-code-use`](https://github.com/ben-vargas/pi-packages/tree/main/packages/pi-claude-code-use), which uses a similar jiti shim to capture and re-export companion tool definitions.

### Caveats

1. **`sourceInfo` attribution.** Tools registered by `--with`-loaded extensions appear sourced from `pi-extension-resources` (because they are registered through our shim, and Pi's runner stamps each registration with the *calling* extension's source info). Their companion `prompts/` and `skills/` are still discovered correctly — we track loaded bundle paths directly and contribute their resource folders alongside the auto-companion logic.

2. **CLI flags from loaded extensions aren't respected.** Pi parses `argv` once at startup, before our factory runs. A `--with`-loaded extension's `registerFlag("foo", ...)` call installs the flag definition but the user's `--foo bar` value never reaches it. Defaults apply. Workarounds: env vars, config files inside the loaded extension.

3. **Mid-session loading isn't supported.** `--with` is consumed exactly once, at factory startup. To change the loaded set, restart pi. There's no `/with` slash command.

---

## Diagnostic command

```
/ext-resources
```

Lists everything this extension knows about:

- Detected extension packages and which contributed `prompts/` / `skills/`
- All paths contributed to Pi's resource scanners
- `--with` managed loads (which names were requested, which resolved, which failed)
- The config file path and current `locations`

Useful when something isn't appearing where you expect.

---

## Limitations & known gaps

- **Companion folder names are fixed** to `prompts` and `skills`. Other names are ignored.
- **Pure event-hook extensions** (no tools, no commands) are invisible to the companion-auto-loader. They can still be loaded via `--with` — only the *attribution* fails.
- **Resource name conflicts** (two packages each shipping `prompts/release.md`) are resolved by Pi's normal load-order rules; this extension just contributes paths.
- **First-run UX gap for `--with`.** The auto-created config has an empty `locations` list, so the first `--with foo` invocation will fail with "no candidate matches" until you populate it. Future versions may auto-discover via ancestor walk.

---

## License

MIT. See [LICENSE](./LICENSE).
