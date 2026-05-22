# @dsshap/pi-loader-with

Load Pi extensions by **short name** with `--with pi-experts,agent-chain`, resolved against a config file — and have their manifest-declared `pi.prompts` / `pi.skills` resources picked up automatically.

```bash
pi -e packages/pi-loader-with --with pi-experts,agent-chain
```

becomes the equivalent of:

```bash
pi -e packages/pi-loader-with -e <path-to-pi-pi-experts> -e <path-to-pi-agent-chain>
```

## Why this exists

Pi's native loader (`pi -e <path>` / `pi install`) reads a package's `package.json` and honors `pi.extensions`, `pi.prompts`, and `pi.skills` — wiring up code *and* resources in one step.

`--with` bypasses that loader (it uses its own `jiti` import so dynamically-loaded extensions can register tools/commands on the running session). Without this package, `--with` would load only the JS code and silently drop any manifest-declared resources.

This package closes that gap: it reads the same `pi.prompts` / `pi.skills` manifest entries the native loader does, and contributes them to Pi's `resources_discover` pipeline.

## Install

```bash
pi install npm:@dsshap/pi-loader-with
```

Or as part of the monorepo:

```bash
pi install git:github.com/dsshap/pi-packages
```

Try without installing:

```bash
cd packages/pi-loader-with
pi -e .
```

---

## Usage

### 1. Declare resources in your package's manifest

```json
{
  "name": "@scope/my-extension",
  "pi": {
    "extensions": ["./extensions/index.ts"],
    "prompts": ["./prompts"],
    "skills":  ["./skills"]
  }
}
```

Both string (`"./prompts"`) and array (`["./prompts", "./more-prompts"]`) forms are accepted. Paths are resolved relative to the package directory.

### 2. Load via `--with`

```bash
pi -e <path-to-pi-loader-with> --with my-extension
```

On startup:

```
[loader-with] loaded via --with: my-extension
```

Pi's resource scanners will then find every `.md` in the declared `prompts/` directory (as slash commands) and every `SKILL.md` under the declared `skills/` directory.

### `--with` syntax

Comma-separated, repeatable. `PI_WITH` is an env-var equivalent.

```bash
# All equivalent
pi -e . --with pi-experts,agent-chain
pi -e . --with pi-experts --with agent-chain
PI_WITH=pi-experts,agent-chain pi -e .
```

Argv names are processed first, then `PI_WITH` (deduped).

---

## Config file

Default location: `~/.pi/agent/extensions/pi-loader-with.json`

On first run with `--with`, this file is auto-created with an empty `locations` list:

```json
{ "locations": [] }
```

**You must populate it** with one or more directories that contain extension package folders (one-level scan):

```json
{
  "locations": [
    "~/pi-packages/packages",
    "~/other-pi-extensions"
  ]
}
```

Each `location` is scanned for one-level subdirectories (skipping `.dotfiles` and `node_modules`). First location wins on duplicate folder names. `~/...` expansion is supported.

Override the config path (e.g. for tests) with `PI_EXTENSION_LOADER_WITH_CONFIG`:

```bash
PI_EXTENSION_LOADER_WITH_CONFIG=/tmp/my-config.json pi -e . --with foo
```

## Name resolution

Three tiers, first tier with a single match wins:

| Tier | Rule | Example |
|---|---|---|
| 1 | Exact folder name | `pi-pi-experts` → `pi-pi-experts` |
| 2 | Case-insensitive exact | `PI-Pi-Experts` → `pi-pi-experts` |
| 3 | Case-insensitive substring | `experts` → `pi-pi-experts` |

Ambiguous matches (more than one in a tier) and unmatched names are reported as warnings on startup; other resolved names still load.

---

## How it works under the hood

1. The `--with` flag is parsed from `argv` and `PI_WITH` at extension startup.
2. Each name is resolved to a directory via the `locations[]` config.
3. The directory's `package.json` is read; `pi.extensions[0]` is loaded via [`jiti`](https://github.com/unjs/jiti) with a passthrough `ExtensionAPI` shim — its `registerTool`, `registerCommand`, `on(...)`, etc. calls land in Pi's live runtime as if Pi had loaded them itself.
4. The same `package.json`'s `pi.prompts` / `pi.skills` paths are captured.
5. On Pi's `resources_discover` event, the captured paths are returned and merged into Pi's resource scanners.

## Caveats

1. **No manifest, no resources.** This package only contributes paths declared in `pi.prompts` / `pi.skills`. If a `--with`-loaded package doesn't declare them, only its code runs. (Prior versions of this package guessed sibling `prompts/`/`skills/` folders by convention; that auto-detection was removed in favor of the manifest, which matches Pi's native behavior.)

2. **Errors are surfaced at startup only.** Unresolved names, ambiguous matches, and load failures are reported once via the `session_start` notification. They are not re-emitted on `/reload`.

---

## License

MIT. See [LICENSE](./LICENSE).
