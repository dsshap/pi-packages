# @dsshap/pi-grid-manager

UI middleware for [Pi](https://github.com/earendil-works/pi-coding-agent). Intercepts every other extension's `ctx.ui.setWidget(...)` call and composes them into a **single grid widget** with configurable columns. Downstream extensions need zero changes — they keep calling `setWidget` like normal.

```
┌─ Pi Pi (9 experts) ─────────────┐  ┌─ plan-build-review ────────────┐
│ ◇ Agent Expert  idle  $0.00 …   │  │ ◇ Orch       $0.00 0/1.0M …    │
│ ◇ Cli Expert    idle  $0.00 …   │  │ ├─◇ Planner  $0.00 0/1.0M …    │
│ ◇ Ext Expert    idle  $0.00 …   │  │ ├─◇ Builder  $0.00 0/1.0M …    │
│ …                               │  │ └─◇ Reviewer $0.00 0/1.0M …    │
└─────────────────────────────────┘  └────────────────────────────────┘
```

## How it works

1. On `session_start`, monkey-patches `ctx.ui.setWidget` on the shared `ExtensionUIContext` singleton.
2. Mounts ONE combined "grid" widget through the original setWidget.
3. Every subsequent `setWidget(key, factory, opts)` call from any extension is captured into an internal map instead of being forwarded as a separate widget.
4. The grid widget's `render(width)` lays captured widgets out in `N` columns with **dynamic width allocation**: widgets that don't use their full cell give the saved space back to widgets that do.

## Install

```bash
pi install @dsshap/pi-grid-manager
```

Then add it to `~/.pi/settings.json` — **list it FIRST** in the `packages` array (see below).

```json
{
  "packages": [
    "@dsshap/pi-grid-manager",
    "@dsshap/pi-pi-experts",
    "@dsshap/pi-agent-chain"
  ]
}
```

## ⚠️ Load order matters

Pi runs `session_start` handlers in **extension load order**. If grid-manager isn't loaded first, sibling extensions can call `setWidget` BEFORE the patch is installed, and those widgets bypass the grid (they appear stacked above it instead of inside it).

Pi's load order (from `resource-loader.js`):

```js
extensionPaths = mergePaths(cliEnabledExtensions, enabledExtensions);
//                          ^^^^^^^^^^^^^^^^^^^^   ^^^^^^^^^^^^^^^^^
//                          `-e` flags             installed packages
//                          (always first)         (settings.json `packages`)
```

**CLI `-e` flags come first**, then `pi install`-installed packages. `mergePaths` dedupes by canonical path (resolves symlinks).

**Symptoms:** widgets appear stacked on initial startup but snap into the grid after `/reload`.

**Why `/reload` works:** the monkey-patch is anchored on the shared UI object via `Symbol.for("pi-grid-manager.patched")`, which persists across reloads. On the second pass, downstream `setWidget` calls hit the wrapper from the very first frame.

### Recipes

**Recipe A — grid-manager installed via `pi install`, extra extensions via `-e`:**

Always list grid-manager FIRST in your `-e` chain (the installed copy is deduped):

```bash
pi -e ./packages/pi-grid-manager/extensions/index.ts \
   -e ./packages/pi-pi-experts/extensions/index.ts \
   -e ./packages/pi-agent-chain/extensions/index.ts
```

**Recipe B — everything in settings, no `-e`:**

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": [
    "@dsshap/pi-grid-manager",   // ← first widget-aware extension
    "@dsshap/pi-pi-experts",
    "@dsshap/pi-agent-chain"
  ]
}
```

Then `pi` (no flags) works. Other non-widget extensions (e.g. `pi-claude-code-use`) can sit anywhere in the array.

**Recipe C — directory rename for `~/.pi/agent/extensions/`:**

If an extension is dropped into `~/.pi/agent/extensions/` (discovered alphabetically BEFORE configured packages), rename grid-manager's directory to sort first:

```bash
mv ~/.pi/agent/extensions/pi-grid-manager ~/.pi/agent/extensions/_pi-grid-manager
```

(`_` sorts before lowercase letters in ASCII.)

## Commands

| Command | Description |
|---|---|
| `/grid` | Show current column count |
| `/grid <1-6>` | Pin to N columns |
| `/grid auto` | Restore auto sizing |

### Auto sizing

| Captured widgets | Effective columns |
|---|---|
| 0–1 | 1 |
| 2 | 2 |
| ≥3 | 2 (rows of 2) |

## Dynamic width allocation

For each grid row:

1. **Probe** every widget at the equal-share cell width.
2. **Measure natural width** = max line width after trailing whitespace is stripped (so widgets that pad-to-fill still report the actual content edge).
3. **Lock** widgets whose natural width < share; **redistribute** saved cells to widgets that filled.
4. **Re-render** stretched widgets at their new (bigger) allocation so they actually use the extra space.

If no widget had slack, this is a single render per widget — same cost as a static grid.

## Reload safety

`/reload` triggers:

1. `clearExtensionWidgets()` on the host — disposes every widget.
2. Builds a new `ExtensionRunner` and reloads every extension.
3. Emits `session_start` with `reason: "reload"`.

The shared `ExtensionUIContext` survives this, so the patched wrapper stays installed. On the new module's session_start, we always re-mount the grid widget (since the host wiped it) and the now-installed wrapper captures downstream setWidget calls correctly from the first frame.

All mutable state (captured widgets, column count, render bridge) is anchored on the UI object via `Symbol.for(...)`, so the old wrapper closure and the new module read/write the same source of truth.

## License

MIT
